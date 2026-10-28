// BizTrack payments: automatic MTN / Airtel mobile money via Relworx.
//
// Routes (one function so it can be deployed from the Supabase dashboard):
//   POST /functions/v1/payments            app calls, signed-in user required
//        { action: "create", plan, phone }  start a payment (PIN prompt)
//        { action: "status", reference }    check one payment
//        { action: "list" }                 the user's recent payments
//   POST /functions/v1/payments/webhook    Relworx calls this when a payment finishes
//
// Deploy with JWT verification OFF (Relworx has no Supabase token).
// The app routes check the user's token themselves.
//
// Secrets (Supabase > Edge Functions > Secrets):
//   RELWORX_API_KEY       API key from Relworx > API Keys
//   RELWORX_ACCOUNT_NO    business account number, e.g. REL...
//   RELWORX_WEBHOOK_KEY   webhook key from Relworx > Business Accounts > View > Settings
//   RELWORX_WEBHOOK_URL   the exact webhook URL entered in Relworx
//                         (https://<project>.supabase.co/functions/v1/payments/webhook)
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.56.0";

// Prices live on the server. The app never sends an amount.
const PRICES: Record<string, number> = { basic: 5000, pro: 7500, premium: 12000 };
const PLAN_NAMES: Record<string, string> = {
  basic: "BizTrack Basic",
  pro: "BizTrack Pro",
  premium: "BizTrack Premium",
};
const CURRENCY = "UGX";
// Ask the provider at most this often for one payment while polling.
const PROVIDER_CHECK_INTERVAL_MS = 15_000;
// A new payment is blocked while another is this fresh and still pending.
const IN_PROGRESS_WINDOW_MS = 3 * 60_000;
// Relworx allows 5 requests per 10 minutes per phone number.
const MAX_CREATES_PER_10_MIN = 5;

const allowedOrigins = [
  "https://allanorabaasa-hash.github.io",
  "https://localhost",
  "capacitor://localhost",
  "http://localhost:8000",
  "http://localhost:8080",
  "http://127.0.0.1:8000",
  "http://127.0.0.1:8080",
];

const json = (body: unknown, status: number, origin = "") => {
  const headers = new Headers({
    "Content-Type": "application/json",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  });
  if (allowedOrigins.includes(origin)) headers.set("Access-Control-Allow-Origin", origin);
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
};

// ---------------------------------------------------------------------------
// Provider interface. To add Flutterwave or MTN/Airtel direct later, write
// another object with these three methods and switch PROVIDER.
// ---------------------------------------------------------------------------
type ProviderStatus = {
  status: "pending" | "success" | "failed";
  providerReference?: string;
  providerTransactionId?: string;
  network?: string;
  amount?: number;
  currency?: string;
  charge?: number;
  message?: string;
};

interface PaymentProvider {
  name: string;
  requestPayment(input: {
    reference: string;
    msisdn: string;
    amount: number;
    description: string;
  }): Promise<{ ok: boolean; providerReference?: string; message: string }>;
  checkStatus(providerReference: string): Promise<ProviderStatus>;
  verifyWebhook(req: Request, rawBody: string): Promise<Record<string, unknown> | null>;
}

const env = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing secret ${name}`);
  return value;
};

const relworxHeaders = () => ({
  "Content-Type": "application/json",
  Accept: "application/vnd.relworx.v2",
  Authorization: `Bearer ${env("RELWORX_API_KEY")}`,
});

const normaliseStatus = (value: unknown): ProviderStatus["status"] => {
  const text = String(value || "").toLowerCase();
  if (text === "success" || text === "successful") return "success";
  if (text === "failed" || text === "failure" || text === "cancelled" || text === "expired")
    return "failed";
  return "pending";
};

const hex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");

const timingSafeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

const relworx: PaymentProvider = {
  name: "relworx",

  async requestPayment({ reference, msisdn, amount, description }) {
    const response = await fetch(
      "https://payments.relworx.com/api/mobile-money/request-payment",
      {
        method: "POST",
        headers: relworxHeaders(),
        body: JSON.stringify({
          account_no: env("RELWORX_ACCOUNT_NO"),
          reference,
          msisdn,
          currency: CURRENCY,
          amount,
          description,
        }),
      },
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success !== true) {
      return {
        ok: false,
        message: String(body.message || body.error || `Payment provider error (${response.status}).`),
      };
    }
    return {
      ok: true,
      providerReference: body.internal_reference ? String(body.internal_reference) : undefined,
      message: String(body.message || "Request payment in progress."),
    };
  },

  async checkStatus(providerReference) {
    const url = new URL("https://payments.relworx.com/api/mobile-money/check-request-status");
    url.searchParams.set("internal_reference", providerReference);
    url.searchParams.set("account_no", env("RELWORX_ACCOUNT_NO"));
    const response = await fetch(url, { headers: relworxHeaders() });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      // Unknown or provider trouble: treat as still pending, never as paid.
      return { status: "pending", message: String(body.message || response.status) };
    }
    return {
      status: normaliseStatus(body.request_status || body.status),
      providerReference: body.internal_reference ? String(body.internal_reference) : providerReference,
      providerTransactionId: body.provider_transaction_id
        ? String(body.provider_transaction_id)
        : undefined,
      network: body.provider ? String(body.provider) : undefined,
      amount: body.amount !== undefined ? Number(body.amount) : undefined,
      currency: body.currency ? String(body.currency) : undefined,
      charge: body.charge !== undefined ? Number(body.charge) : undefined,
      message: body.message ? String(body.message) : undefined,
    };
  },

  // Relworx-Signature: t=<timestamp>,v=<hex hmac-sha256>
  // Signed string: webhook URL + timestamp + (key + value) for
  // customer_reference, internal_reference, status in alphabetical order.
  async verifyWebhook(req, rawBody) {
    const header = req.headers.get("Relworx-Signature") || "";
    const parts = Object.fromEntries(
      header.split(",").map((part) => {
        const [key, ...rest] = part.trim().split("=");
        return [key, rest.join("=")];
      }),
    );
    const timestamp = parts.t;
    const signature = (parts.v || "").toLowerCase();
    if (!timestamp || !signature) return null;

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      payload = Object.fromEntries(new URLSearchParams(rawBody));
    }
    const signed = ["customer_reference", "internal_reference", "status"]
      .map((key) => `${key}${payload[key] ?? ""}`)
      .join("");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env("RELWORX_WEBHOOK_KEY")),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const expected = hex(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`${env("RELWORX_WEBHOOK_URL")}${timestamp}${signed}`),
      ),
    );
    return timingSafeEqual(expected, signature) ? payload : null;
  },
};

const PROVIDER: PaymentProvider = relworx;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Accepts 0772123456, 772123456, 256772123456, +256 772 123 456.
const normaliseUgandaPhone = (input: unknown) => {
  let digits = String(input || "").replace(/\D/g, "");
  if (digits.startsWith("256")) digits = digits.slice(3);
  else if (digits.startsWith("0")) digits = digits.slice(1);
  if (!/^7\d{8}$/.test(digits)) return null;
  return `+256${digits}`;
};

const makeReference = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return `BT${hex(bytes.buffer)}`; // 22 characters, within Relworx's 8-36
};

const accessSummary = async (admin: SupabaseClient, userId: string) => {
  const { data } = await admin
    .from("biztrack_profiles")
    .select("subscription_plan, trial_ends_at, plan_expires_at")
    .eq("user_id", userId)
    .maybeSingle();
  return {
    plan: data?.subscription_plan || "basic",
    trialEndsAt: data?.trial_ends_at || null,
    planExpiresAt: data?.plan_expires_at || null,
  };
};

type PaymentRow = {
  id: string;
  user_id: string;
  plan: string;
  status: string;
  amount: number;
  currency: string;
  reference: string;
  provider_reference: string | null;
  failure_reason: string | null;
  last_checked_at: string | null;
  created_at: string;
  verified_at: string | null;
};

// Ask the provider for the real outcome and record it. This is the only
// place a payment becomes verified, whether triggered by the webhook, by
// the app polling, or on next login.
const reconcile = async (admin: SupabaseClient, payment: PaymentRow) => {
  if (payment.status === "verified") return payment.status;
  const lookup = payment.provider_reference || payment.reference;
  const result = await PROVIDER.checkStatus(lookup);
  await admin
    .from("biztrack_payments")
    .update({ last_checked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", payment.id);

  if (result.status === "success") {
    const amountMatches =
      result.amount === undefined || Math.abs(Number(result.amount) - Number(payment.amount)) < 0.01;
    const currencyMatches = !result.currency || result.currency.toUpperCase() === payment.currency;
    if (!amountMatches || !currencyMatches) {
      await admin
        .from("biztrack_payments")
        .update({
          status: "failed",
          failure_reason: "Amount did not match. Contact support.",
          updated_at: new Date().toISOString(),
        })
        .eq("id", payment.id)
        .neq("status", "verified");
      console.error("Payment amount mismatch", payment.reference, result);
      return "failed";
    }
    const { error } = await admin.rpc("biztrack_grant_payment", {
      p_reference: payment.reference,
      p_provider_reference: result.providerReference ?? null,
      p_provider_transaction_id: result.providerTransactionId ?? null,
      p_network: result.network ?? null,
      p_charge: result.charge ?? null,
    });
    if (error) throw error;
    return "verified";
  }

  if (result.status === "failed" && payment.status === "pending") {
    await admin
      .from("biztrack_payments")
      .update({
        status: "failed",
        failure_reason: result.message || "The payment was declined or cancelled.",
        updated_at: new Date().toISOString(),
      })
      .eq("id", payment.id)
      .eq("status", "pending");
    return "failed";
  }
  return payment.status;
};

const publicPayment = (p: PaymentRow) => ({
  reference: p.reference,
  plan: p.plan,
  amount: Number(p.amount),
  status: p.status,
  failureReason: p.failure_reason,
  createdAt: p.created_at,
  verifiedAt: p.verified_at,
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const handleWebhook = async (req: Request, admin: SupabaseClient) => {
  const rawBody = await req.text();
  let payload: Record<string, unknown> | null;
  try {
    payload = await PROVIDER.verifyWebhook(req, rawBody);
  } catch (error) {
    console.error("Webhook verification error", error);
    return json({ error: "Webhook not configured." }, 500);
  }
  if (!payload) return json({ error: "Invalid signature." }, 401);

  const reference = String(payload.customer_reference || "");
  const { data: payment } = await admin
    .from("biztrack_payments")
    .select("*")
    .eq("reference", reference)
    .maybeSingle();
  // Unknown reference: acknowledge so Relworx stops retrying.
  if (!payment) return json({ received: true }, 200);

  if (!payment.provider_reference && payload.internal_reference) {
    await admin
      .from("biztrack_payments")
      .update({ provider_reference: String(payload.internal_reference) })
      .eq("id", payment.id)
      .is("provider_reference", null);
    payment.provider_reference = String(payload.internal_reference);
  }

  // Never trust the webhook body alone: confirm with the provider.
  try {
    await reconcile(admin, payment as PaymentRow);
  } catch (error) {
    console.error("Webhook reconcile failed", reference, error);
    return json({ error: "Try again." }, 500); // Relworx will retry
  }
  return json({ received: true }, 200);
};

const handleApp = async (req: Request, admin: SupabaseClient, origin: string) => {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "Please log in again." }, 401, origin);
  const authClient = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"));
  const {
    data: { user },
    error: authError,
  } = await authClient.auth.getUser(token);
  if (authError || !user) return json({ error: "Please log in again." }, 401, origin);

  let body: { action?: string; plan?: string; phone?: string; reference?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request." }, 400, origin);
  }

  if (body.action === "list") {
    const { data, error } = await admin
      .from("biztrack_payments")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(10);
    if (error) return json({ error: "Could not load payments." }, 500, origin);
    return json({ payments: (data || []).map(publicPayment) }, 200, origin);
  }

  if (body.action === "status") {
    const { data: payment, error } = await admin
      .from("biztrack_payments")
      .select("*")
      .eq("user_id", user.id)
      .eq("reference", String(body.reference || ""))
      .maybeSingle();
    if (error) return json({ error: "Could not load payment." }, 500, origin);
    if (!payment) return json({ error: "Payment not found." }, 404, origin);

    let status = payment.status;
    const lastChecked = Date.parse(payment.last_checked_at || payment.created_at);
    if (status === "pending" && Date.now() - lastChecked >= PROVIDER_CHECK_INTERVAL_MS) {
      try {
        status = await reconcile(admin, payment as PaymentRow);
      } catch (error) {
        console.error("Status reconcile failed", payment.reference, error);
      }
    }
    const { data: fresh } = await admin
      .from("biztrack_payments")
      .select("*")
      .eq("id", payment.id)
      .single();
    return json(
      { payment: publicPayment((fresh || { ...payment, status }) as PaymentRow), access: await accessSummary(admin, user.id) },
      200,
      origin,
    );
  }

  if (body.action !== "create") return json({ error: "Unknown action." }, 400, origin);

  const plan = String(body.plan || "");
  if (!(plan in PRICES)) return json({ error: "Choose a valid plan." }, 400, origin);
  const msisdn = normaliseUgandaPhone(body.phone);
  if (!msisdn)
    return json(
      { error: "Enter a valid MTN or Airtel Uganda number, e.g. 0772 123 456." },
      400,
      origin,
    );

  const { data: recent, error: recentError } = await admin
    .from("biztrack_payments")
    .select("*")
    .eq("user_id", user.id)
    .gte("created_at", new Date(Date.now() - 10 * 60_000).toISOString())
    .order("created_at", { ascending: false });
  if (recentError) return json({ error: "Could not start the payment." }, 500, origin);

  const inProgress = (recent || []).find(
    (p) => p.status === "pending" && Date.now() - Date.parse(p.created_at) < IN_PROGRESS_WINDOW_MS,
  );
  if (inProgress)
    return json(
      {
        error: "You already have a payment waiting. Approve it on your phone or wait a few minutes.",
        payment: publicPayment(inProgress as PaymentRow),
      },
      409,
      origin,
    );
  if ((recent || []).length >= MAX_CREATES_PER_10_MIN)
    return json({ error: "Too many payment attempts. Please wait 10 minutes." }, 429, origin);

  const { data: profile } = await admin
    .from("biztrack_profiles")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!profile) return json({ error: "Your profile is not set up yet. Log in again." }, 409, origin);

  const reference = makeReference();
  const amount = PRICES[plan];
  const { data: payment, error: insertError } = await admin
    .from("biztrack_payments")
    .insert({
      user_id: user.id,
      plan,
      amount,
      currency: CURRENCY,
      msisdn,
      provider: PROVIDER.name,
      reference,
      status: "pending",
    })
    .select("*")
    .single();
  if (insertError) return json({ error: "Could not start the payment." }, 500, origin);

  let result;
  try {
    result = await PROVIDER.requestPayment({
      reference,
      msisdn,
      amount,
      description: `${PLAN_NAMES[plan]} - 30 days`,
    });
  } catch (error) {
    console.error("requestPayment threw", error);
    result = { ok: false, message: "The payment service is unavailable. Try again shortly." };
  }

  if (!result.ok) {
    await admin
      .from("biztrack_payments")
      .update({ status: "failed", failure_reason: result.message, updated_at: new Date().toISOString() })
      .eq("id", payment.id);
    return json({ error: result.message }, 502, origin);
  }

  if (result.providerReference) {
    await admin
      .from("biztrack_payments")
      .update({ provider_reference: result.providerReference, updated_at: new Date().toISOString() })
      .eq("id", payment.id);
  }

  return json(
    {
      payment: publicPayment(payment as PaymentRow),
      message: "Check your phone and enter your Mobile Money PIN to approve the payment.",
    },
    201,
    origin,
  );
};

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") return json({}, 204, origin);
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405, origin);

  let admin: SupabaseClient;
  try {
    admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  } catch {
    return json({ error: "Server is not configured." }, 500, origin);
  }

  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  try {
    if (path.endsWith("/webhook")) return await handleWebhook(req, admin);
    return await handleApp(req, admin, origin);
  } catch (error) {
    console.error("payments function error", error);
    return json({ error: "Something went wrong. Try again." }, 500, origin);
  }
});
