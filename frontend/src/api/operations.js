import { supabase } from "../lib/supabaseClient";
import { ApiError } from "./client";

/**
 * Operations API — notifications (0007), driver runs (0006), inspector
 * (0006), support queue (0009), kiosk (0008). Every call hits a real
 * migration RPC/RLS table; nothing is canned. Errors keep the
 * "field: message" convention the screens parse.
 */

// ============================================================================
// READ ME FIRST — this file is the bridge between the screens and the DB
// ============================================================================
// This one file (frontend/src/api/operations.js) is where every staff
// screen goes to read or write data. No screen ever imports "supabase"
// directly and no screen ever writes raw database queries — they all call
// a plain-named function from here instead (e.g. lookupCardForInspection,
// startRun, claimTicket). That keeps every database call in ONE place,
// which is why this file is so long.
//
// There are two different ways a function in this file can reach the
// database, and it matters which one it uses:
//
//   1. rpc(name, args) — below — calls a named function that lives INSIDE
//      the Postgres database itself ("RPC" = remote procedure call). These
//      names always match a `create function public.<name>(...)` block in
//      one of the .sql files under supabase/migrations/. This is used for
//      anything that changes data (inserting, updating) or that needs
//      business-rule checks (e.g. "is this person actually an inspector?")
//      done safely on the server, not trusted to the browser.
//      Example: rpc("log_inspection_outcome", {...}) runs the SQL function
//      named log_inspection_outcome, wherever it's defined.
//
//   2. supabase.from("table_name").select(...) — a plain read straight off
//      a database table, no custom function involved. Used for simple
//      "just show me what's in this table" screens. What a signed-in user
//      is allowed to see this way is controlled entirely by the database's
//      Row Level Security ("RLS") rules attached to that table — also
//      defined in the .sql migration files, as `create policy ...`
//      statements.
//
// So: to find out EXACTLY what happens when a button on screen is
// pressed, look at which function it calls here, then search the
// supabase/migrations/*.sql files for that same name.
// ============================================================================

function toApiError(error, fallbackStatus = 400) {
  const message = error?.message || "Request failed";
  const code = error?.code;
  if (code === "42501" || /^FORBIDDEN/i.test(message)) {
    return new ApiError(403, { error: "You don't have permission for that action." });
  }
  if (code === "55000" || /already claimed|not PENDING|already resolved|owned by another/i.test(message)) {
    return new ApiError(409, { error: message });
  }
  return new ApiError(fallbackStatus, { error: message });
}

// The actual bridge function. Every rpc("some_name", {...}) call below
// sends "some_name" + its arguments to Supabase, which finds and runs the
// Postgres function of that exact name (search supabase/migrations/*.sql
// for `function public.some_name`). Whatever that SQL function `return`s
// comes back here as `data`. If the SQL function fails (e.g. it does
// `raise exception 'FORBIDDEN'`), that shows up here as `error` instead,
// and gets converted into a friendlier error message by toApiError above.
function rpc(fn, args) {
  return supabase.rpc(fn, args).then(({ data, error }) => {
    if (error) throw toApiError(error);
    return data;
  });
}

// Table helper reserved for future direct-table reads; notifications use
// typed calls below.
// =====================================================================
// Notifications (0007) — D3
// =====================================================================

export async function fetchNotifications(limit = 50) {
  const { data, error } = await supabase
    .from("notifications")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw toApiError(error);
  return (data || []).map(mapNotification);
}

export async function fetchUnreadCount() {
  const { count, error } = await supabase
    .from("notifications", { count: "exact", head: true })
    .select("*", { count: "exact", head: true })
    .is("read_at", null);
  if (error) throw toApiError(error);
  return count || 0;
}

export async function markNotificationsRead(ids = null) {
  const count = await rpc("mark_notifications_read", { p_ids: ids });
  return count ?? 0;
}

function mapNotification(n) {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    linkPath: n.link_path,
    readAt: n.read_at,
    createdAt: n.created_at,
  };
}

// =====================================================================
// Support — commuter side (0001/0002 tables + add_ticket_message)
// =====================================================================

export async function fetchMyTickets() {
  const { data, error } = await supabase
    .from("support_tickets")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw toApiError(error);
  return (data || []).map(mapTicket);
}

function mapTicket(t) {
  return {
    id: t.id,
    subject: t.subject,
    status: t.status,
    lastMessageAt: t.last_message_at,
    lastSender: t.last_sender,
    createdAt: t.created_at,
  };
}

/**
 * Single message shape for every chat consumer (commuter support,
 * agent inbox). `from` is the view-facing bubble side; `sender` is the
 * raw DB enum.
 */
export function mapTicketMessage(m) {
  return {
    id: m.id,
    ticketId: m.ticket_id,
    from: m.sender === "COMMUTER" ? "user" : "agent",
    text: m.body,
    time: new Date(m.sent_at).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" }),
    sentAt: m.sent_at,
    sender: m.sender,
  };
}

export async function createTicket(subject, firstMessage) {
  const { data, error } = await supabase
    .from("support_tickets")
    .insert({ subject, status: "OPEN", priority: "NORMAL" })
    .select("id")
    .single();
  if (error) throw toApiError(error);
  if (firstMessage) {
    await rpc("add_ticket_message", {
      p_ticket_id: data.id,
      p_sender: "COMMUTER",
      p_body: firstMessage,
    });
  }
  return data.id;
}

export async function fetchTicketMessages(ticketId) {
  const { data, error } = await supabase
    .from("ticket_messages")
    .select("*")
    .eq("ticket_id", ticketId)
    .order("sent_at");
  if (error) throw toApiError(error);
  return (data || []).map(mapTicketMessage);
}

export async function sendCommuterMessage(ticketId, body) {
  return rpc("add_ticket_message", { p_ticket_id: ticketId, p_sender: "COMMUTER", p_body: body });
}

// ---------------------------------------------------------------------
// Realtime chat plumbing (0011). One place owns the channel wiring —
// screens and the useTicketChat hook just subscribe; every message,
// including your own echoes, arrives INSERT-by-INSERT (WhatsApp-style
// message-by-message delivery). Dedupe happens in the hook.
// ---------------------------------------------------------------------

/**
 * Subscribe to live INSERTs on a ticket's thread. Returns an unsubscribe
 * function. `onMessage` receives a mapped message (mapTicketMessage).
 */
export function subscribeTicketMessages(ticketId, onMessage) {
  const channel = supabase
    .channel(`ticket-messages-${ticketId}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "ticket_messages", filter: `ticket_id=eq.${ticketId}` },
      (payload) => onMessage(mapTicketMessage(payload.new)),
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}

/**
 * Subscribe to ticket-level changes (status flips, claim/resolve, and
 * the 0011 last_message_at/last_sender stamps). Returns unsubscribe.
 * `onUpdate` receives the raw new row.
 */
export function subscribeTicketMeta(ticketId, onUpdate) {
  const channel = supabase
    .channel(`ticket-meta-${ticketId}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "support_tickets", filter: `id=eq.${ticketId}` },
      (payload) => onUpdate(payload.new),
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}

/**
 * Subscribe to ANY ticket-level change (0011 puts support_tickets on the
 * realtime publication). One subscription keeps a whole queue/list view
 * live — the inbox uses this so claim/resolve/status flips from any
 * agent show up without a manual reload.
 */
export function subscribeAllTickets(onUpdate) {
  const channel = supabase
    .channel("tickets-all")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "support_tickets" },
      (payload) => onUpdate(payload.new || payload.old),
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}

// =====================================================================
// Support — agent side (0009): queue, claim, reply, resolve, escalate
// =====================================================================

export async function fetchTicketQueue() {
  const queue = await rpc("ticket_queue", {});
  return (queue || []).map((t) => ({
    id: t.id,
    subject: t.subject,
    status: t.status,
    priority: t.priority,
    commuter: t.commuter,
    lastMessage: t.last_message,
    messageCount: t.message_count,
    assignedTo: t.assigned_to,
    lastMessageAt: t.last_message_at,
    lastSender: t.last_sender,
    createdAt: t.created_at,
  }));
}

export const claimTicket = (id) => rpc("claim_ticket", { p_ticket_id: id });
export const replyTicket = (id, body) => rpc("reply_ticket", { p_ticket_id: id, p_body: body });
export const resolveTicket = (id) => rpc("resolve_ticket", { p_ticket_id: id });
export const escalateTicket = (id, note) => rpc("escalate_ticket", { p_ticket_id: id, p_note: note || null });

/** Agent heartbeat — call on console open and once a minute. */
export const setAgentOnline = (online = true) => rpc("set_agent_online", { p_online: online });

/**
 * My staff row (0011): phone + names for the agent profile page.
 * Reads go through RLS (staff can read own row); mapping keeps the
 * camelCase shape the screens use.
 */
export async function fetchMyStaffProfile() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;
  const { data, error } = await supabase
    .from("staff")
    .select("first_name, surname, email, phone, role")
    .eq("id", session.user.id)
    .maybeSingle();
  if (error) throw toApiError(error);
  if (!data) return null;
  return {
    firstName: data.first_name,
    surname: data.surname,
    email: data.email,
    phone: data.phone || "",
    role: data.role,
  };
}

export async function fetchAgentsOnline() {
  const result = await rpc("agents_online", {});
  return result || { online: false, count: 0 };
}

// =====================================================================
// Driver (0006): runs + status
// =====================================================================

export async function fetchMyRuns() {
  // The read policy lets every staff role see every run (the admin fleet
  // view needs that), so "my" runs must be filtered here or a second
  // driver's run would show up as this driver's current run.
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return [];
  const { data, error } = await supabase
    .from("vehicle_runs")
    .select("*")
    .eq("driver_id", session.user.id)
    .order("started_at", { ascending: false })
    .limit(60); // generous enough to cover a week of multi-run shifts for on-time stats
  if (error) throw toApiError(error);
  return (data || []).map(mapRun);
}

function mapRun(r) {
  return {
    id: r.id,
    routeCode: r.route_code,
    busId: r.bus_id,
    direction: r.direction,
    serviceDay: r.service_day,
    status: r.status,
    delayMinutes: r.delay_minutes,
    note: r.note,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

export async function fetchBuses() {
  const { data, error } = await supabase
    .from("buses")
    .select("fleet_no, depot")
    .eq("active", true)
    .order("fleet_no");
  if (error) throw toApiError(error);
  return data || [];
}

export const startRun = (routeCode, busId, direction, note = null) =>
  rpc("start_run", {
    p_route_code: routeCode,
    p_bus_id: busId,
    p_direction: direction || "OUTBOUND",
    p_note: note,
  });

export const reportRunStatus = (runId, status, delayMinutes = 0, note = null) =>
  rpc("report_run_status", {
    p_run_id: runId,
    p_status: status,
    p_delay_minutes: delayMinutes,
    p_note: note,
  });

// =====================================================================
// Inspector (0006): handheld verifier (BR-08)
// =====================================================================
// This whole section is what the two screens in
// frontend/src/screens/staff/inspector/ (VerifyScreen.jsx and
// InspectionHistoryScreen.jsx) call. Two of the four functions below use
// rpc() (they run a named function inside Postgres); the other two just
// read straight from the "inspection_events" table.
//
// The underlying database objects — the "inspection_events" table itself,
// the two RPC functions, and the security rules controlling who can
// insert/read rows — were first created in
// supabase/migrations/0006_operations.sql, and a security bug in the
// permission rules (any staff role could insert a fake record, not just
// inspectors) was fixed later in
// supabase/migrations/0016_inspector_hardening.sql. If you want to see
// exactly what runs on the server, open those two files and search for
// "lookup_card_for_inspection" / "log_inspection_outcome" /
// "inspection_events_insert".

// Called by VerifyScreen.jsx when the inspector presses "Look up".
// Runs the lookup_card_for_inspection(p_card_number) function in the
// database, which reads the card's details (status, journeys left,
// concession info, loaded products, and its 3 most recent past
// inspections) and returns them as one bundle. The database function
// itself checks that the caller is actually an INSPECTOR (or ADMIN)
// before returning anything — that check happens on the server, not here,
// so it can't be bypassed from the browser.
export const lookupCardForInspection = (cardNumber) =>
  rpc("lookup_card_for_inspection", { p_card_number: cardNumber.trim().toUpperCase() });

// Called by VerifyScreen.jsx when the inspector taps one of the outcome
// buttons (Valid / No product / Expired / Unregistered / Refused).
// Runs the log_inspection_outcome(p_card_number, p_outcome, p_note)
// function in the database, which permanently inserts one new row into
// the "inspection_events" table — this is the actual audit record. Same
// as above, the server checks the caller is an INSPECTOR/ADMIN and that
// the card really exists before it allows the insert.
export const logInspectionOutcome = (cardNumber, outcome, note = null) =>
  rpc("log_inspection_outcome", {
    p_card_number: cardNumber.trim().toUpperCase(),
    p_outcome: outcome,
    p_note: note,
  });

/**
 * Called by InspectionHistoryScreen.jsx (the "History" tab). This is a
 * plain read, not an RPC — it just asks the "inspection_events" table for
 * its most recent rows, across EVERY inspector, not just the person
 * currently logged in. It's allowed to see everyone's rows because of the
 * "inspection_events_read" database policy (any INSPECTOR or ADMIN can
 * read all rows) — see supabase/migrations/0006_operations.sql.
 */
export async function fetchRecentInspections(limit = 15) {
  const { data, error } = await supabase
    .from("inspection_events")
    .select("id, inspector_id, card_number, outcome, note, at")
    .order("at", { ascending: false })
    .limit(limit);
  if (error) throw toApiError(error);
  return data || [];
}

/**
 * Called by VerifyScreen.jsx for the "YOUR RECENT LOOKUPS" shortcut list
 * near the bottom of that screen. Also a plain read of the
 * "inspection_events" table, but this time filtered down to only the
 * rows where inspector_id matches whoever is currently logged in
 * (supabase.auth.getUser() is how we find out who that is) — so two
 * different inspectors looking at this same list on their own phones
 * would each see only their own past lookups.
 */
export async function fetchMyRecentInspections(limit = 8) {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return [];
  const { data, error } = await supabase
    .from("inspection_events")
    .select("id, card_number, outcome, note, at")
    .eq("inspector_id", auth.user.id)
    .order("at", { ascending: false })
    .limit(limit);
  if (error) throw toApiError(error);
  return data || [];
}

// =====================================================================
// Clerk kiosk (0008)
// =====================================================================

export const recordCashSale = (cardNumber, productCode, routeCode) =>
  rpc("record_cash_sale", {
    p_card_number: cardNumber.trim().toUpperCase(),
    p_product_code: productCode,
    p_route_code: routeCode,
  });

export const clerkIssueCard = (idNumber, routeCode = null, productCode = null) =>
  rpc("clerk_issue_card", {
    p_id_number: idNumber.replace(/\s/g, ""),
    p_route_code: routeCode,
    p_product_code: productCode,
  });

export const clerkReplaceLostCard = (oldCardNumber) =>
  rpc("clerk_replace_lost_card", { p_old_card_number: oldCardNumber.trim().toUpperCase() });

export async function fetchMyKioskSalesToday() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const { count, error } = await supabase
    .from("top_up_orders")
    .select("*", { count: "exact", head: true })
    .gte("created_at", startOfDay.toISOString())
    .eq("status", "PAID");
  if (error) throw toApiError(error);
  return count || 0;
}

// =====================================================================
// Admin — team (0005)
// =====================================================================

export async function fetchStaffTeam() {
  const { data, error } = await supabase
    .from("staff")
    .select("id, first_name, surname, email, role, active")
    .order("role")
    .order("first_name");
  if (error) throw toApiError(error);
  return (data || []).map((s) => ({
    id: s.id,
    firstName: s.first_name,
    surname: s.surname,
    email: s.email,
    role: s.role,
    active: s.active,
  }));
}

export const setStaffActive = (staffId, active) =>
  rpc("set_staff_active", { p_staff_id: staffId, p_active: active });

// =====================================================================
// Admin — live fleet + alerts (Driver ↔ Admin end-to-end interaction)
// =====================================================================
// Right now every row in service_alerts comes from a DRIVER's DELAYED/
// BREAKDOWN report (the 0006 trigger on vehicle_runs — see RunsScreen.jsx
// and 0006_operations.sql). This is the admin-side half of that loop:
// see what's currently live on the road, and correct/withdraw an alert
// if a driver's situation has changed since they reported it. This does
// NOT create new alerts from scratch (routes/severity/scheduling) — that
// stays a separate ADMIN "publish alert" feature for whoever builds the
// full catalog/alerts lane; this is scoped to what's already there.

/** Every driver run currently in progress, fleet-wide (ADMIN can read any driver's row — RLS). */
export async function fetchAllOpenRuns() {
  const { data, error } = await supabase
    .from("vehicle_runs")
    .select("id, route_code, bus_id, direction, status, delay_minutes, started_at, staff:driver_id(first_name, surname)")
    .is("ended_at", null)
    .order("started_at", { ascending: false });
  if (error) throw toApiError(error);
  return (data || []).map((r) => ({
    id: r.id,
    routeCode: r.route_code,
    busId: r.bus_id,
    direction: r.direction,
    status: r.status,
    delayMinutes: r.delay_minutes,
    startedAt: r.started_at,
    driverName: r.staff ? `${r.staff.first_name} ${r.staff.surname}` : "—",
  }));
}

/**
 * Ends an alert early by setting effective_to = now(). A plain table
 * update, not an RPC — ADMIN already has write access to service_alerts
 * via the existing "service_alerts_write" RLS policy (0001_schema.sql),
 * so no new database function was needed for this.
 */
export async function withdrawAlert(alertId) {
  const { error } = await supabase
    .from("service_alerts")
    .update({ effective_to: new Date().toISOString() })
    .eq("id", alertId);
  if (error) throw toApiError(error);
  return true;
}

// =====================================================================
// Staff — self-service account (0014): Delete(=deactivate). Update
// (name/surname/phone/password) is updateMyStaffDetails in api/staff.js.
// =====================================================================

export const deactivateMyAccount = () => rpc("deactivate_my_account", {});

// =====================================================================
// Live run status for the commuter Route screen (mock M4 killed here)
// =====================================================================

export async function fetchLiveRuns(routeCode) {
  const { data, error } = await supabase
    .from("vehicle_runs")
    .select("*")
    .eq("route_code", routeCode)
    .in("status", ["ON_TIME", "DELAYED", "BREAKDOWN", "DIVERTED"])
    .order("started_at", { ascending: false })
    .limit(5);
  if (error) throw toApiError(error);
  return (data || []).map(mapRun);
}

// =====================================================================
// Clerk — concessions queue (0002 BR-06) — Sprint 2 K3, Joshua Black
// =====================================================================

/**
 * Commuters with an unverified STUDENT/PENSIONER concession.
 * RLS lets CLERK read the commuters table; the 0007 trigger notifies the
 * commuter automatically when verify_concession stamps concession_verified_at.
 */
export async function fetchPendingConcessions() {
  const { data, error } = await supabase
    .from("commuters")
    .select("id, first_name, surname, email, concession_type, concession_verified_at, created_at")
    .in("concession_type", ["STUDENT", "PENSIONER"])
    .is("concession_verified_at", null)
    .order("created_at", { ascending: true });
  if (error) throw toApiError(error);
  return data || [];
}

/** Recently verified claims — the "done" column of the queue. */
export async function fetchRecentVerifiedConcessions(limit = 5) {
  const { data, error } = await supabase
    .from("commuters")
    .select("id, first_name, surname, concession_type, concession_verified_at")
    .in("concession_type", ["STUDENT", "PENSIONER"])
    .not("concession_verified_at", "is", null)
    .order("concession_verified_at", { ascending: false })
    .limit(limit);
  if (error) throw toApiError(error);
  return data || [];
}

/** BR-06 — stamp the claim verified; triggers the commuter notification. */
export const verifyConcession = (commuterId) => rpc("verify_concession", { p_commuter_id: commuterId });

// =====================================================================
// Clerk — dashboard (Sprint 2 K1)
// =====================================================================

/** Today's PAID cash takings, split out by product kind. */
export async function fetchKioskSalesSummary() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const { data, error } = await supabase
    .from("top_up_orders")
    .select("product_code, amount_cents")
    .gte("created_at", startOfDay.toISOString())
    .eq("status", "PAID");
  if (error) throw toApiError(error);

  const rows = data || [];
  const feeRows = rows.filter((r) => r.product_code === "GOLD-CARD-FEE");
  return {
    orders: rows.length - feeRows.length,
    fees: feeRows.length,
    cents: rows.reduce((sum, r) => sum + (r.amount_cents || 0), 0),
  };
}

/** The clerk's own cash sales today (staff_action_log is action-scoped). */
export async function fetchMySalesToday() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const { data, error } = await supabase
    .from("staff_action_log")
    .select("details")
    .eq("action", "CASH_SALE")
    .gte("created_at", startOfDay.toISOString());
  if (error) return { count: 0, receipts: [] }; // log is optional telemetry
  const receipts = (data || []).map((r) => ({
    card: r.details?.card || "—",
    product: r.details?.product || "—",
    cents: r.details?.cents || 0,
  }));
  return { count: receipts.length, receipts };
}

// =====================================================================
// Clerk — kiosk activity feed (Sprint 2 K2, Joshua Black)
// =====================================================================

/**
 * Every PAID kiosk transaction today — loads, card-issue fees and
 * replacement fees — newest first. Powers the kiosk "menu stack"
 * activity list. RLS: CLERK/ADMIN may read top_up_orders.
 */
export async function fetchKioskActivityToday(limit = 40) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const { data, error } = await supabase
    .from("top_up_orders")
    .select("id, card_number, product_code, amount_cents, receipt_reference, created_at")
    .gte("created_at", startOfDay.toISOString())
    .eq("status", "PAID")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw toApiError(error);
  return (data || []).map((r) => ({
    id: r.id,
    card: r.card_number,
    kind: r.product_code === "GOLD-CARD-FEE" ? "FEE" : "LOAD",
    product: r.product_code,
    amountCents: r.amount_cents || 0,
    receipt: r.receipt_reference,
    at: r.created_at,
  }));
}
