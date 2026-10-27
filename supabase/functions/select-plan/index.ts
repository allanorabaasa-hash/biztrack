import { createClient } from "https://esm.sh/@supabase/supabase-js@2.56.0";

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
  if (allowedOrigins.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers,
  });
};

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") return jsonResponse({}, 204, origin);
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405, origin);
  }

  const authorization = req.headers.get("Authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token || token === authorization) {
    return jsonResponse(
      { error: "A valid bearer token is required." },
      401,
      origin,
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse(
      { error: "Supabase function environment is incomplete." },
      500,
      origin,
    );
  }

  const authClient = createClient(supabaseUrl, anonKey);
  const {
    data: { user },
    error: authError,
  } = await authClient.auth.getUser(token);
  if (authError || !user) {
    return jsonResponse(
      { error: "Your session is invalid or expired." },
      401,
      origin,
    );
  }

  let body: { plan?: unknown; validateCurrent?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "A JSON plan is required." }, 400, origin);
  }
  const validateCurrent = body.validateCurrent === true;
  if (
    !validateCurrent &&
    (typeof body.plan !== "string" ||
      !["basic", "pro", "premium"].includes(body.plan))
  ) {
    return jsonResponse({ error: "Choose a valid plan." }, 400, origin);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: profile, error: profileError } = await admin
    .from("biztrack_profiles")
    .select("subscription_plan, trial_ends_at")
    .eq("user_id", user.id)
    .maybeSingle();
  if (profileError) {
    return jsonResponse({ error: "Could not load your plan." }, 500, origin);
  }
  const plan = validateCurrent
    ? profile?.subscription_plan || "basic"
    : body.plan;
  if (typeof plan !== "string" || !["basic", "pro", "premium"].includes(plan)) {
    return jsonResponse({ error: "Choose a valid plan." }, 400, origin);
  }

  const trialMode = Deno.env.get("TRIAL_MODE")?.toLowerCase() === "true";
  const trialDaysValue = Number(Deno.env.get("TRIAL_DAYS") || 30);
  const trialDays =
    Number.isInteger(trialDaysValue) && trialDaysValue > 0
      ? Math.min(trialDaysValue, 3650)
      : 30;
  const existingTrialEnd = profile?.trial_ends_at || null;
  const trialExpired = Boolean(
    trialMode && existingTrialEnd && Date.parse(existingTrialEnd) <= Date.now(),
  );

  if (trialExpired) {
    const { error } = await admin
      .from("biztrack_profiles")
      .update({
        subscription_plan: "basic",
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", user.id);
    if (error)
      return jsonResponse(
        { error: "Could not update your plan." },
        500,
        origin,
      );
    return jsonResponse(
      {
        plan: "basic",
        trialEndsAt: existingTrialEnd,
        trialEnded: true,
        trialMode,
      },
      200,
      origin,
    );
  }

  let trialEndsAt = existingTrialEnd;
  if (trialMode && !trialEndsAt) {
    trialEndsAt = new Date(
      Date.now() + trialDays * 24 * 60 * 60 * 1000,
    ).toISOString();
  }

  if (!trialMode && plan !== "basic") {
    // TODO: Verify MTN MoMo or Airtel Money callbacks here before marking a payment verified.
    const { data: payment, error } = await admin
      .from("biztrack_payments")
      .select("id")
      .eq("user_id", user.id)
      .eq("plan", plan)
      .eq("status", "verified")
      .not("verified_at", "is", null)
      .limit(1)
      .maybeSingle();
    if (error)
      return jsonResponse(
        { error: "Could not verify payment status." },
        500,
        origin,
      );
    if (!payment) {
      if (validateCurrent && profile) {
        const { error: downgradeError } = await admin
          .from("biztrack_profiles")
          .update({
            subscription_plan: "basic",
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", user.id);
        if (downgradeError) {
          return jsonResponse(
            { error: "Could not update your plan." },
            500,
            origin,
          );
        }
        return jsonResponse(
          { plan: "basic", trialEndsAt, trialEnded: false, trialMode },
          200,
          origin,
        );
      }
      return jsonResponse(
        { error: "A verified payment for this plan is required." },
        402,
        origin,
      );
    }
  }

  const updates: Record<string, string | null> = {
    subscription_plan: plan,
    trial_ends_at: trialEndsAt,
    updated_at: new Date().toISOString(),
  };
  const { error: updateError } = profile
    ? await admin
        .from("biztrack_profiles")
        .update(updates)
        .eq("user_id", user.id)
    : await admin.from("biztrack_profiles").insert({
        user_id: user.id,
        email: user.email || "",
        name: String(user.user_metadata?.name || "BizTrack user"),
        ...updates,
      });
  if (updateError) {
    return jsonResponse({ error: "Could not save your plan." }, 500, origin);
  }

  return jsonResponse(
    { plan, trialEndsAt, trialEnded: false, trialMode },
    200,
    origin,
  );
});
