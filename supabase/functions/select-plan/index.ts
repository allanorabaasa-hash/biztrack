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
  if (allowedOrigins.includes(origin))
    headers.set("Access-Control-Allow-Origin", origin);
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers,
  });
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

  let body: { validateCurrent?: unknown; plan?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "A JSON request is required." }, 400, origin);
  }
  if (body.validateCurrent !== true && body.plan !== "basic") {
    return jsonResponse(
      { error: "Only Basic can be selected without a payment." },
      400,
      origin,
    );
  }

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: profile, error } = await admin
    .from("biztrack_profiles")
    .select("subscription_plan, trial_ends_at, plan_expires_at")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error)
    return jsonResponse(
      { error: "Could not load your access status." },
      500,
      origin,
    );

  const now = Date.now();
  const paidActive = Boolean(
    profile?.plan_expires_at && Date.parse(profile.plan_expires_at) > now,
  );
  const trialWasUsed = Boolean(profile?.trial_ends_at);
  let trialEndsAt = profile?.trial_ends_at || null;
  let planExpiresAt = profile?.plan_expires_at || null;
  let plan = profile?.subscription_plan || "basic";
  let trialStarted = false;

  if (!trialWasUsed) {
    trialEndsAt = new Date(now + 7 * 86400000).toISOString();
    if (!paidActive) plan = "basic";
    trialStarted = true;
  } else if (!paidActive) {
    plan = "basic";
    planExpiresAt = null;
  }

  if (
    !profile ||
    plan !== profile.subscription_plan ||
    trialEndsAt !== profile.trial_ends_at ||
    planExpiresAt !== profile.plan_expires_at
  ) {
    const update = {
      user_id: user.id,
      email: user.email || "",
      name: String(user.user_metadata?.name || "BizTrack user"),
      subscription_plan: plan,
      trial_ends_at: trialEndsAt,
      plan_expires_at: planExpiresAt,
      updated_at: new Date().toISOString(),
    };
    const saved = profile
      ? await admin
          .from("biztrack_profiles")
          .update(update)
          .eq("user_id", user.id)
      : await admin.from("biztrack_profiles").insert(update);
    if (saved.error)
      return jsonResponse(
        { error: "Could not save your access status." },
        500,
        origin,
      );
  }

  const access = paidActive
    ? "paid"
    : trialEndsAt && Date.parse(trialEndsAt) > now
    ? "trial"
    : "read_only";
  return jsonResponse(
    {
      plan,
      trialEndsAt,
      planExpiresAt,
      access,
      trialStarted,
      trialDaysLeft:
        trialEndsAt && Date.parse(trialEndsAt) > now
          ? Math.ceil((Date.parse(trialEndsAt) - now) / 86400000)
          : 0,
      planDaysLeft: paidActive
        ? Math.ceil((Date.parse(planExpiresAt!) - now) / 86400000)
        : 0,
    },
    200,
    origin,
  );
});
