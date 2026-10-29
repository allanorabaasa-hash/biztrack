// BizTrack: permanently delete the signed-in user's account.
//
// Deletes the Supabase Auth user. The database removes their profile,
// encrypted workspace and payment records automatically (each table
// references auth.users with ON DELETE CASCADE).
//
// Deploy with JWT verification ON. The app asks for the password again and
// signs in with it right before calling this, so a stolen session alone is
// not enough: the token must be less than 5 minutes old.

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
const RECENT_LOGIN_SECONDS = 5 * 60;

const json = (body: unknown, status: number, origin: string) => {
  const headers = new Headers({
    "Content-Type": "application/json",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  });
  if (allowedOrigins.includes(origin)) headers.set("Access-Control-Allow-Origin", origin);
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
};

// Reads the "iat" (issued at) time from the access token. The token's
// signature is checked by auth.getUser below.
const issuedAt = (token: string) => {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return Number(payload.iat) || 0;
  } catch {
    return 0;
  }
};

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") return json({}, 204, origin);
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405, origin);

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "Please log in again." }, 401, origin);

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return json({ error: "Server is not configured." }, 500, origin);

  const {
    data: { user },
    error,
  } = await createClient(url, anonKey).auth.getUser(token);
  if (error || !user) return json({ error: "Please log in again." }, 401, origin);

  let body: { confirm?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  if (body.confirm !== "DELETE") return json({ error: "Deletion was not confirmed." }, 400, origin);
  if (Date.now() / 1000 - issuedAt(token) > RECENT_LOGIN_SECONDS)
    return json({ error: "For your safety, enter your password again." }, 401, origin);

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: deleteError } = await admin.auth.admin.deleteUser(user.id);
  if (deleteError) {
    console.error("deleteUser failed", user.id, deleteError);
    return json({ error: "Your account could not be deleted. Try again or contact support." }, 500, origin);
  }
  return json({ deleted: true }, 200, origin);
});
