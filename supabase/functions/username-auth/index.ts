// BizTrack: username sign-in and accounts without an email address.
//
//   POST { action: "login", username, password }        -> { session }
//   POST { action: "signup", username, password, name, salt } -> { session }
//   POST { action: "available", username }             -> { available }
//
// Deploy with JWT verification OFF (people call it before they are signed in).
//
// Supabase sign-in needs an email address, so an account created with only a
// username gets an internal address <username>@<USERNAME_EMAIL_DOMAIN> that
// never receives mail and is never shown to the user. Accounts created with a
// real email can also sign in by username once they set one in their profile.
//
// Optional secret: USERNAME_EMAIL_DOMAIN (default users.biztrack.invalid; the
// ".invalid" ending is reserved and can never belong to anyone).

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
const USERNAME_RE = /^[a-z0-9_.]{3,30}$/;
const MAX_FAILED_LOGINS = 8; // per username per 15 minutes
const MAX_SIGNUPS = 30; // username-only signups, all users, per 10 minutes

const json = (body: unknown, status: number, origin: string) => {
  const headers = new Headers({
    "Content-Type": "application/json",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  });
  if (allowedOrigins.includes(origin)) headers.set("Access-Control-Allow-Origin", origin);
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
};

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") return json({}, 204, origin);
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405, origin);

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return json({ error: "Server is not configured." }, 500, origin);
  const domain = (Deno.env.get("USERNAME_EMAIL_DOMAIN") || "users.biztrack.invalid").trim().toLowerCase();

  let body: { action?: string; username?: string; password?: string; name?: string; salt?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request." }, 400, origin);
  }
  const username = String(body.username || "").trim().replace(/^@/, "").toLowerCase();
  if (!USERNAME_RE.test(username))
    return json({ error: "Usernames use 3–30 letters, numbers, dots or underscores." }, 400, origin);

  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  // Usernames are stored in lowercase (a database rule enforces it), so an
  // exact match is a case-insensitive match.
  const exactProfile = async () => {
    const { data, error } = await admin
      .from("biztrack_profiles")
      .select("user_id, email")
      .eq("username", username)
      .maybeSingle();
    if (error) throw error;
    return data;
  };

  const signIn = async (email: string, password: string) => {
    const client = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error || !data.session) return null;
    return {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    };
  };

  try {
    if (body.action === "available") {
      return json({ available: !(await exactProfile()) }, 200, origin);
    }

    if (body.action === "login") {
      const password = String(body.password || "");
      const { count } = await admin
        .from("biztrack_auth_attempts")
        .select("id", { count: "exact", head: true })
        .eq("kind", "login_failed")
        .eq("username", username)
        .gte("created_at", minutesAgo(15));
      if ((count || 0) >= MAX_FAILED_LOGINS)
        return json({ error: "Too many wrong attempts. Wait 15 minutes and try again." }, 429, origin);

      const profile = await exactProfile();
      const session = profile?.email && password ? await signIn(profile.email, password) : null;
      if (!session) {
        await admin.from("biztrack_auth_attempts").insert({ kind: "login_failed", username });
        // Same answer whether the username exists or not.
        return json({ error: "Wrong username or password." }, 401, origin);
      }
      await admin.from("biztrack_auth_attempts").delete().eq("kind", "login_failed").eq("username", username);
      return json({ session }, 200, origin);
    }

    if (body.action === "signup") {
      const password = String(body.password || "");
      const name = String(body.name || "").trim().slice(0, 80);
      const salt = String(body.salt || "");
      if (password.length < 10) return json({ error: "Use a password with at least 10 characters." }, 400, origin);
      if (!name) return json({ error: "Enter your name." }, 400, origin);
      if (!/^[A-Za-z0-9+/]{22}==$/.test(salt)) return json({ error: "Invalid request." }, 400, origin);

      const { count } = await admin
        .from("biztrack_auth_attempts")
        .select("id", { count: "exact", head: true })
        .eq("kind", "signup")
        .gte("created_at", minutesAgo(10));
      if ((count || 0) >= MAX_SIGNUPS)
        return json({ error: "Lots of people are signing up right now. Try again in a few minutes." }, 429, origin);
      if (await exactProfile()) return json({ error: "That username is taken. Try another." }, 409, origin);

      const email = `${username}@${domain}`;
      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { name, salt, username, login: "username" },
      });
      if (createError || !created.user) {
        const taken = /already|registered|exists/i.test(createError?.message || "");
        console.error("createUser failed", createError);
        return json(
          { error: taken ? "That username is taken. Try another." : "Could not create the account. Try again." },
          taken ? 409 : 500,
          origin,
        );
      }
      await admin.from("biztrack_auth_attempts").insert({ kind: "signup", username });
      const { error: profileError } = await admin.from("biztrack_profiles").insert({
        user_id: created.user.id,
        email,
        name,
        username,
      });
      if (profileError) {
        await admin.auth.admin.deleteUser(created.user.id);
        const taken = profileError.code === "23505";
        return json(
          { error: taken ? "That username is taken. Try another." : "Could not create the account. Try again." },
          taken ? 409 : 500,
          origin,
        );
      }
      const session = await signIn(email, password);
      if (!session) return json({ error: "Account created. Please log in." }, 201, origin);
      return json({ session }, 200, origin);
    }

    return json({ error: "Unknown action." }, 400, origin);
  } catch (error) {
    console.error("username-auth error", error);
    return json({ error: "Something went wrong. Try again." }, 500, origin);
  }
});
