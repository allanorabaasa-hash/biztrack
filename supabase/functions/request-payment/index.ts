import { createClient } from "https://esm.sh/@supabase/supabase-js@2.56.0";

const prices: Record<string, number> = {
  basic: 5000,
  pro: 7500,
  premium: 12000,
};
const allowedOrigins = [
  "https://allanorabaasa-hash.github.io",
  "https://localhost",
  "capacitor://localhost",
  "http://localhost:8000",
  "http://localhost:8080",
  "http://127.0.0.1:8000",
  "http://127.0.0.1:8080",
];
const jsonResponse = (body: unknown, status: number, origin: string) => {
  const headers = new Headers({
    "Content-Type": "application/json",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  });
  if (allowedOrigins.includes(origin))
    headers.set("Access-Control-Allow-Origin", origin);
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers,
  });
};
const makeReference = () => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return `BT-${Array.from(
    bytes,
    (byte) => alphabet[byte % alphabet.length],
  ).join("")}`;
};

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") return jsonResponse({}, 204, origin);
  if (req.method !== "POST")
    return jsonResponse({ error: "Method not allowed." }, 405, origin);
  const token = (req.headers.get("Authorization") || "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  if (!token)
    return jsonResponse(
      { error: "A valid bearer token is required." },
      401,
      origin,
    );

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey)
    return jsonResponse(
      { error: "Supabase function environment is incomplete." },
      500,
      origin,
    );
  const auth = createClient(url, anonKey);
  const {
    data: { user },
    error: authError,
  } = await auth.auth.getUser(token);
  if (authError || !user)
    return jsonResponse(
      { error: "Your session is invalid or expired." },
      401,
      origin,
    );

  let body: {
    action?: string;
    plan?: string;
    provider?: string;
    transactionId?: string;
    reference?: string;
  };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "A JSON request is required." }, 400, origin);
  }
  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  if (body.action === "list") {
    const { data, error } = await admin
      .from("biztrack_payments")
      .select(
        "reference_code, plan, amount, provider, provider_transaction_id, status, rejection_reason, created_at, verified_at",
      )
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error)
      return jsonResponse(
        { error: "Could not load payment requests." },
        500,
        origin,
      );
    return jsonResponse({ requests: data }, 200, origin);
  }

  const plan = body.plan || "";
  if (!(plan in prices))
    return jsonResponse({ error: "Choose a valid plan." }, 400, origin);
  if (body.action === "prepare") {
    let reference = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      reference = makeReference();
      const { error } = await admin.from("biztrack_payment_intents").insert({
        reference_code: reference,
        user_id: user.id,
        plan,
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
      if (!error) break;
      if (error.code !== "23505" || attempt === 4)
        return jsonResponse(
          { error: "Could not prepare payment reference." },
          500,
          origin,
        );
    }
    return jsonResponse({ reference, plan, amount: prices[plan] }, 200, origin);
  }
  if (body.action !== "submit")
    return jsonResponse(
      { error: "Choose prepare, submit, or list." },
      400,
      origin,
    );

  const provider = body.provider || "";
  const transactionId = String(body.transactionId || "").trim();
  const reference = String(body.reference || "")
    .trim()
    .toUpperCase();
  if (
    !(provider === "mtn_momo" || provider === "airtel_money") ||
    !transactionId ||
    !reference
  ) {
    return jsonResponse(
      { error: "Select a network and enter the SMS transaction ID." },
      400,
      origin,
    );
  }
  if (!/^BT-[A-HJ-NP-Z2-9]{4}$/.test(reference))
    return jsonResponse(
      { error: "Payment reference is invalid." },
      400,
      origin,
    );

  const { data: intent, error: intentError } = await admin
    .from("biztrack_payment_intents")
    .select("reference_code, plan, expires_at, used_at")
    .eq("reference_code", reference)
    .eq("user_id", user.id)
    .maybeSingle();
  if (intentError)
    return jsonResponse(
      { error: "Could not verify payment reference." },
      500,
      origin,
    );
  if (
    !intent ||
    intent.used_at ||
    intent.plan !== plan ||
    Date.parse(intent.expires_at) <= Date.now()
  )
    return jsonResponse(
      {
        error:
          "Payment reference expired or does not match this plan. Prepare a new request.",
      },
      400,
      origin,
    );

  const { count, error: countError } = await admin
    .from("biztrack_payments")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("status", "pending");
  if (countError)
    return jsonResponse(
      { error: "Could not check pending requests." },
      500,
      origin,
    );
  if ((count || 0) >= 3)
    return jsonResponse(
      {
        error:
          "You already have three pending payment requests. Wait for confirmation before submitting another.",
      },
      429,
      origin,
    );

  const { data: consumed, error: consumeError } = await admin
    .from("biztrack_payment_intents")
    .update({ used_at: new Date().toISOString() })
    .eq("reference_code", reference)
    .eq("user_id", user.id)
    .is("used_at", null)
    .select("reference_code")
    .maybeSingle();
  if (consumeError || !consumed)
    return jsonResponse(
      { error: "Payment reference was already submitted or expired." },
      409,
      origin,
    );

  // TODO: Replace manual review with verified MTN MoMo/Airtel Money API callbacks.
  const { data, error } = await admin
    .from("biztrack_payments")
    .insert({
      user_id: user.id,
      plan,
      amount: prices[plan],
      currency: "UGX",
      provider,
      provider_transaction_id: transactionId,
      reference_code: reference,
      status: "pending",
    })
    .select("reference_code, plan, amount, provider, status, created_at")
    .single();
  if (error) {
    await admin
      .from("biztrack_payment_intents")
      .update({ used_at: null })
      .eq("reference_code", reference)
      .eq("user_id", user.id);
    if (error.code === "23505")
      return jsonResponse(
        {
          error: "That transaction ID or reference has already been submitted.",
        },
        409,
        origin,
      );
    return jsonResponse(
      { error: "Could not submit the payment request." },
      500,
      origin,
    );
  }
  return jsonResponse({ request: data }, 201, origin);
});
