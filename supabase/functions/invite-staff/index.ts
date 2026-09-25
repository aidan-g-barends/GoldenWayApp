// supabase/functions/invite-staff/index.ts
//
// Called by OnboardingScreen right after an ADMIN approves a staff
// request. Creates the auth.users row via inviteUserByEmail() and sends
// Supabase's built-in "Invite user" email (through the same custom SMTP
// already configured for commuter emails). The applicant sets their
// password on /staff/complete-signup after clicking the link.
//
// Secrets required (set via `supabase secrets set`):
//   SUPABASE_URL              — project URL (also auto-injected by the
//                                runtime as SUPABASE_URL; kept explicit
//                                here for clarity)
//   SUPABASE_SERVICE_ROLE_KEY — service role / secret key. NEVER expose
//                                this to the frontend.
//   FRONTEND_URL               — e.g. http://localhost:5173 in dev,
//                                the real domain once deployed. Used to
//                                build the redirect the invite link
//                                lands on after the person clicks it.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FRONTEND_URL = Deno.env.get("FRONTEND_URL")!;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// CORS: only your own frontend calls this, but the browser still needs
// the preflight answered.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Caller must be a signed-in ADMIN — verify with THEIR token, not
    // the service role key, so this function can't be hit anonymously.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Missing Authorization header" }, 401);
    }
    const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const {
      data: { user: caller },
    } = await callerClient.auth.getUser();
    if (!caller) {
      return json({ error: "Invalid session" }, 401);
    }
    const { data: staffRow, error: staffErr } = await admin
      .from("staff")
      .select("role, active")
      .eq("id", caller.id)
      .maybeSingle();
    if (staffErr || !staffRow || staffRow.role !== "ADMIN" || !staffRow.active) {
      return json({ error: "FORBIDDEN" }, 403);
    }

    const body = await req.json();
    const { email, firstName, surname, requestedRole, requestId } = body ?? {};
    if (!email || !requestId) {
      return json({ error: "email and requestId are required" }, 400);
    }

    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
      data: {
        account_type: "STAFF",
        staff_request_id: requestId,
        requested_role: requestedRole ?? null,
        first_name: firstName ?? null,
        surname: surname ?? null,
      },
      redirectTo: `${FRONTEND_URL}/staff/complete-signup`,
    });

    if (error) {
      // Supabase returns a specific message when the email already
      // belongs to a confirmed user — surface it plainly rather than
      // a generic 500.
      return json({ error: error.message }, 400);
    }

    return json({ ok: true, userId: data.user?.id ?? null });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}