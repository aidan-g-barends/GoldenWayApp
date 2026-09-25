import { supabase } from "../lib/supabaseClient";
import { ApiError } from "./client";

/**
 * Staff console API — D2 (ADMIN onboarding queue) — FINAL-DEV-PLAN §5.
 * Talks to the 0005 migration RPCs:
 *   · staff_access_requests rows are read directly (RLS: ADMIN sees all,
 *     a pending requester sees only their own row — 0010 hotfix).
 *   · decide_staff_access(request_id, approve, note) — ADMIN-only.
 *   · create_staff_member(email, first_name, surname, role) — the ADMIN
 *     direct-invite door (pre-approved request; the person signs up with
 *     that email and the 0005 trigger attaches their role).
 */

function toApiError(error, fallbackStatus = 400) {
  const message = error?.message || "Request failed";
  const code = error?.code;
  if (code === "42501" || /forbidden/i.test(message)) {
    return new ApiError(403, { error: "Admin only" });
  }
  if (/not PENDING|nothing to decide/i.test(message)) {
    return new ApiError(409, {
      error: "This request was already decided — refresh the queue.",
    });
  }
  if (/already exists|duplicate/i.test(message)) {
    return new ApiError(409, { error: message });
  }
  return new ApiError(fallbackStatus, { error: message });
}

function mapRequest(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    surname: row.surname,
    requestedRole: row.requested_role,
    motivation: row.motivation,
    status: row.status,
    decisionNote: row.decision_note,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
    onboardedAt: row.onboarded_at,
  };
}

/** The onboarding queue. status: "PENDING" (default), "APPROVED", "DENIED" or "ALL". */
export async function fetchStaffRequests(status = "PENDING") {
  let query = supabase
    .from("staff_access_requests")
    .select("*")
    .order("requested_at", { ascending: true });
  if (status !== "ALL") query = query.eq("status", status);
  const { data, error } = await query;
  if (error) throw toApiError(error);
  return (data || []).map(mapRequest);
}

/** Approve or deny a PENDING request (ADMIN-only RPC). */
export async function decideStaffAccess(requestId, approve, note) {
  const row = await supabase
    .rpc("decide_staff_access", {
      p_request_id: requestId,
      p_approve: approve,
      p_note: note?.trim() || null,
    })
    .then(({ data, error }) => {
      if (error) throw toApiError(error);
      return data;
    });
  return mapRequest(Array.isArray(row) ? row[0] : row);
}

/**
 * Fires the invite-staff Edge Function after an ADMIN approves a
 * request — creates the auth.users row via inviteUserByEmail() and
 * sends Supabase's "Invite user" email (through the existing custom
 * SMTP). The applicant sets a password on /staff/complete-signup.
 */
export async function sendStaffInvite({
  requestId,
  email,
  firstName,
  surname,
  requestedRole,
}) {
  const { data, error } = await supabase.functions.invoke("invite-staff", {
    body: {
      requestId,
      email,
      firstName,
      surname,
      requestedRole,
    },
  });
  if (error) {
    // supabase-js wraps non-2xx responses in error; the function's own
    // { error: "..." } body is usually in error.context, but fall back
    // to a generic message if that shape ever changes.
    const message =
      error.context?.error ||
      error.message ||
      "Could not send the invite email";
    throw new ApiError(400, { error: message });
  }
  return data;
}

/** Direct invite: pre-approve someone who never self-requested (ADMIN-only). */
export async function inviteStaffMember({ email, firstName, surname, role }) {
  const row = await supabase
    .rpc("create_staff_member", {
      p_email: email.trim(),
      p_first_name: firstName.trim(),
      p_surname: surname.trim(),
      p_role: role,
    })
    .then(({ data, error }) => {
      if (error) throw toApiError(error);
      return data;
    });
  return mapRequest(Array.isArray(row) ? row[0] : row);
}

// ---------------------------------------------------------------------
// OTP onboarding (migration 0011) — REMOVED in 0012.
// Staff onboarding now needs no email/OTP: the applicant signs up with a
// password, the ADMIN approves, and the approval trigger creates their
// staff row. The sign-in gate lives in loginAny() (src/api/auth.js).
// ---------------------------------------------------------------------

/** ADMIN: latest staff audit-log entries (staff_action_log, ADMIN-gated). */
export async function fetchStaffAuditLog(limit = 30) {
  const { data, error } = await supabase
    .from("staff_action_log")
    .select("id,actor_id,action,entity,entity_id,details,at")
    .order("at", { ascending: false })
    .limit(limit);
  if (error) throw toApiError(error);
  return (data || []).map((row) => ({
    id: row.id,
    actorId: row.actor_id,
    action: row.action,
    entity: row.entity,
    entityId: row.entity_id,
    details: row.details || {},
    at: row.at,
  }));
}

// ---------------------------------------------------------------------
// Self-service profile (migration 0013) — every staff role, CLERK
// included, edits their own name / phone / password from the Profile tab.
// ---------------------------------------------------------------------

/**
 * Update my own staff profile. Password change requires the CURRENT
 * password (verified server-side against auth.users bcrypt hash).
 * @returns {{ firstName, surname, phone, email, role, passwordChanged }}
 */
export async function updateMyStaffDetails({
  firstName,
  surname,
  phone,
  changePassword = false,
  currentPassword,
  newPassword,
}) {
  const row = await supabase
    .rpc("update_my_staff_details", {
      p_first_name: firstName.trim(),
      p_surname: surname.trim(),
      p_phone: phone?.trim() || null,
      p_change_password: changePassword,
      p_current_password: changePassword ? currentPassword : null,
      p_new_password: changePassword ? newPassword : null,
    })
    .then(({ data, error }) => {
      if (error) throw error;
      return data;
    });
  const payload = Array.isArray(row) ? row[0] : row;
  if (!payload)
    throw new ApiError(500, {
      error: "Empty response from update_my_staff_details",
    });
  return {
    firstName: payload.firstName,
    surname: payload.surname,
    phone: payload.phone,
    email: payload.email,
    role: payload.role,
    passwordChanged: payload.passwordChanged,
  };
}
