import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  fetchStaffRequests,
  decideStaffAccess,
  inviteStaffMember,
  sendStaffInvite,
} from "../../../api/staff";
import { ApiError } from "../../../api/client";

/**
 * ADMIN — Onboarding queue (FINAL-DEV-PLAN §5 D2, QuesAndSuggest point 2).
 * Lists staff_access_requests. Approval creates the applicant's staff row
 * via the 0012 trigger (they signed up already, so their account goes
 * live immediately); Deny records the reason and removes the applicant's
 * auth account (0012 purge trigger). Also hosts the direct-invite door
 * (create_staff_member) so the ADMIN never has to fall back to raw SQL.
 */

const STATUS_TABS = ["PENDING", "APPROVED", "DENIED", "ALL"];

const ROLE_PILL = {
  ADMIN: "bg-red-500/15 text-red-300 border-red-400/30",
  CLERK: "bg-gold-400/10 text-gold-300 border-gold-400/30",
  INSPECTOR: "bg-sky-400/10 text-sky-300 border-sky-400/30",
  DRIVER: "bg-emerald-400/10 text-emerald-300 border-emerald-400/30",
  AGENT: "bg-violet-400/10 text-violet-300 border-violet-400/30",
};

export default function OnboardingScreen() {
  const [tab, setTab] = useState("PENDING");
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [message, setMessage] = useState(null); // {kind: 'ok'|'err', text}
  const [denying, setDenying] = useState(null); // request being denied (modal)
  const [denyNote, setDenyNote] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);

  const load = useCallback(async (status) => {
    setLoading(true);
    setMessage(null);
    try {
      setRequests(await fetchStaffRequests(status));
    } catch (err) {
      setMessage({
        kind: "err",
        text: err?.message || "Could not load the queue",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(tab);
  }, [tab, load]);

  async function decide(request, approve) {
    if (busyId) return;
    setBusyId(request.id);
    setMessage(null);
    try {
      const updated = await decideStaffAccess(
        request.id,
        approve,
        approve ? null : denyNote.trim() || null,
      );
      if (approve) {
        // Fire the invite email. This is a best-effort second step —
        // the approval itself already succeeded and is recorded; if the
        // email send fails, the request is still APPROVED, so we show a
        // warning rather than rolling anything back. An admin can retry
        // by re-approving via attach_staff_to_existing_account or by
        // asking the applicant to check spam first.
        try {
          await sendStaffInvite({
            requestId: updated.id,
            email: updated.email,
            firstName: updated.firstName,
            surname: updated.surname,
            requestedRole: updated.requestedRole,
          });
          setMessage({
            kind: "ok",
            text: `${updated.email} approved as ${updated.requestedRole} — an invite email has been sent.`,
          });
        } catch (inviteErr) {
          setMessage({
            kind: "err",
            text: `${updated.email} was approved, but the invite email failed to send: ${inviteErr?.message || "unknown error"}. You may need to retry manually.`,
          });
        }
      } else {
        setMessage({
          kind: "ok",
          text: `${updated.email} denied — their account has been removed.`,
        });
      }
      setDenying(null);
      setDenyNote("");
      if (tab !== "PENDING") load(tab);
      else setRequests((rows) => rows.filter((r) => r.id !== request.id));
    } catch (err) {
      setMessage({
        kind: "err",
        text: err?.message || "Could not save the decision",
      });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="px-5 pt-2">
      <div className="mx-auto max-w-3xl">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-xl font-bold text-ink-900">
              Onboarding queue
            </h1>
            <p className="text-[13px] text-ink-900/50 mt-1">
              Approve or deny staff access requests. Approval activates the
              account the applicant created at sign-up.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setInviteOpen(true)}
            className="btn-gold shrink-0 px-4 py-2.5 text-[12px] rounded-lg"
          >
            + Invite staff
          </button>
        </header>

        <div className="mt-6 flex gap-1.5">
          {STATUS_TABS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setTab(s)}
              className={`rounded-full px-3.5 py-1.5 text-[11px] font-semibold tracking-wide transition-colors ${
                tab === s
                  ? "bg-gold-400 text-ink-900"
                  : "border border-ink-900/10 text-ink-900/50 hover:text-ink-900/80"
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        {message && (
          <div
            role="status"
            className={`mt-4 rounded-xl px-4 py-3 text-[12px] font-medium ${
              message.kind === "ok"
                ? "border border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
                : "border border-red-400/30 bg-red-400/10 text-red-300"
            }`}
          >
            {message.text}
          </div>
        )}

        <div className="mt-4 flex flex-col gap-3">
          {loading && (
            <p className="text-[13px] text-ink-900/40 py-6 text-center">
              Loading…
            </p>
          )}

          {!loading && requests.length === 0 && (
            <div className="rounded-2xl border border-dashed border-ink-900/10 py-10 text-center">
              <p className="text-[13px] text-ink-900/50">
                {tab === "PENDING"
                  ? "The queue is clear. 🎉"
                  : `No ${tab === "ALL" ? "" : tab.toLowerCase()} requests.`}
              </p>
            </div>
          )}

          {!loading &&
            requests.map((r) => (
              <motion.article
                key={r.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
                className="rounded-2xl border border-ink-900/10 bg-white p-5 shadow-[0_14px_30px_-18px_rgba(0,0,0,0.6)]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="font-display text-[15px] font-semibold truncate">
                      {r.firstName} {r.surname}
                    </h2>
                    <p className="text-[12px] text-ink-900/50 truncate">
                      {r.email}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-bold tracking-wider ${
                      ROLE_PILL[r.requestedRole] ||
                      "border-ink-900/15 text-ink-900/55"
                    }`}
                  >
                    {r.requestedRole}
                  </span>
                </div>

                {r.motivation && (
                  <p className="mt-3 text-[12.5px] leading-relaxed text-ink-900/70 italic">
                    “{r.motivation}”
                  </p>
                )}

                <p className="mt-2 text-[11px] text-ink-900/35">
                  Requested {new Date(r.requestedAt).toLocaleString()}
                </p>

                {r.status === "PENDING" ? (
                  <div className="mt-4 flex gap-2">
                    <button
                      type="button"
                      disabled={busyId === r.id}
                      onClick={() => decide(r, true)}
                      className="flex-1 rounded-xl bg-emerald-500 py-2.5 text-[12px] font-bold text-white hover:bg-emerald-400 transition-all hover:shadow-[0_10px_24px_-10px_rgba(16,185,129,0.5)] disabled:opacity-50 active:scale-[0.98]"
                    >
                      {busyId === r.id ? "Saving…" : "Approve"}
                    </button>
                    <button
                      type="button"
                      disabled={busyId === r.id}
                      onClick={() => setDenying(r)}
                      className="flex-1 rounded-xl border border-ink-900/10 py-2.5 text-[12px] font-semibold text-ink-900/70 hover:text-ink-900 hover:border-ink-900/25 transition-colors disabled:opacity-50"
                    >
                      Deny
                    </button>
                  </div>
                ) : (
                  <p className="mt-3 text-[11px] text-ink-900/40">
                    {r.status}
                    {r.decidedAt
                      ? ` · decided ${new Date(r.decidedAt).toLocaleString()}`
                      : ""}
                    {r.onboardedAt ? " · account activated ✓" : ""}
                    {r.decisionNote ? ` · note: ${r.decisionNote}` : ""}
                  </p>
                )}
              </motion.article>
            ))}
        </div>
      </div>

      <DenyModal
        request={denying}
        note={denyNote}
        setNote={setDenyNote}
        busy={busyId !== null}
        onClose={() => {
          setDenying(null);
          setDenyNote("");
        }}
        onConfirm={() => denying && decide(denying, false)}
      />
      <InviteModal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onInvited={(msg) => {
          setInviteOpen(false);
          setMessage({ kind: "ok", text: msg });
          setTab("APPROVED");
        }}
      />
    </div>
  );
}

function DenyModal({ request, note, setNote, busy, onClose, onConfirm }) {
  if (!request) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-6"
      role="dialog"
      aria-modal="true"
    >
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-sm rounded-2xl border border-ink-900/10 bg-white p-6"
      >
        <h2 className="font-display text-lg font-bold">Deny request</h2>
        <p className="text-[12.5px] text-ink-900/55 mt-1">
          {request.firstName} {request.surname} · {request.email}
        </p>
        <textarea
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Reason (optional) — shown in the audit log"
          className="mt-4 w-full rounded-xl border border-ink-900/10 bg-cream-200 px-4 py-3 text-[13px] text-ink-900 placeholder:text-ink-900/30 outline-none focus:border-gold-400/60 resize-none"
        />
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-xl border border-ink-900/10 py-2.5 text-[12px] font-semibold text-ink-900/70 hover:text-ink-900"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="flex-1 rounded-xl bg-red-500 py-2.5 text-[12px] font-bold text-white hover:bg-red-400 disabled:opacity-50"
          >
            Deny request
          </button>
        </div>
      </motion.div>
    </div>
  );
}

const ROLES = ["DRIVER", "INSPECTOR", "CLERK", "AGENT", "ADMIN"];

function InviteModal({ open, onClose, onInvited }) {
  const [form, setForm] = useState({
    email: "",
    firstName: "",
    surname: "",
    role: "DRIVER",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!open) return null;

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) {
      setError("Enter a valid email address.");
      return;
    }
    if (!form.firstName.trim() || !form.surname.trim()) {
      setError("Enter their first name and surname.");
      return;
    }
    setBusy(true);
    try {
      const row = await inviteStaffMember(form);
      try {
        await sendStaffInvite({
          requestId: row.id,
          email: row.email,
          firstName: row.firstName,
          surname: row.surname,
          requestedRole: row.requestedRole,
        });
        onInvited(
          `${row.email} invited as ${row.requestedRole} — an invite email has been sent.`,
        );
      } catch (inviteErr) {
        onInvited(
          `${row.email} was pre-approved as ${row.requestedRole}, but the invite email failed to send: ${inviteErr?.message || "unknown error"}. You may need to retry manually.`,
        );
      }
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not send the invite",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-6"
      role="dialog"
      aria-modal="true"
    >
      <motion.form
        onSubmit={submit}
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-sm rounded-2xl border border-ink-900/10 bg-white p-6"
      >
        <h2 className="font-display text-lg font-bold">
          Invite a staff member
        </h2>
        <p className="text-[12px] text-ink-900/50 mt-1">
          Pre-approves their email — they finish by signing up with it.
        </p>
        {error && (
          <p
            role="alert"
            className="mt-3 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-[12px] text-red-300"
          >
            {error}
          </p>
        )}
        <div className="mt-4 flex flex-col gap-3">
          <input
            type="email"
            placeholder="Work email"
            value={form.email}
            onChange={set("email")}
            className="w-full rounded-xl border border-ink-900/10 bg-cream-200 px-4 py-3 text-[13px] text-ink-900 placeholder:text-ink-900/30 outline-none focus:border-gold-400/60"
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              placeholder="First name"
              value={form.firstName}
              onChange={set("firstName")}
              className="w-full rounded-xl border border-ink-900/10 bg-cream-200 px-4 py-3 text-[13px] text-ink-900 placeholder:text-ink-900/30 outline-none focus:border-gold-400/60"
            />
            <input
              placeholder="Surname"
              value={form.surname}
              onChange={set("surname")}
              className="w-full rounded-xl border border-ink-900/10 bg-cream-200 px-4 py-3 text-[13px] text-ink-900 placeholder:text-ink-900/30 outline-none focus:border-gold-400/60"
            />
          </div>
          <select
            value={form.role}
            onChange={set("role")}
            className="w-full rounded-xl border border-ink-900/10 bg-cream-200 px-4 py-3 text-[13px] text-ink-900 outline-none focus:border-gold-400/60"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-xl border border-ink-900/10 py-2.5 text-[12px] font-semibold text-ink-900/70 hover:text-ink-900"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="flex-1 rounded-xl bg-gradient-to-r from-gold-400 to-gold-500 py-2.5 text-[12px] font-bold text-ink-900 disabled:opacity-50"
          >
            Send invite
          </button>
        </div>
      </motion.form>
    </div>
  );
}
