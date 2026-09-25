import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { supabase } from "../../lib/supabaseClient";

/**
 * Landing page for the invite-staff email link. Supabase's invite flow
 * authenticates the browser via a one-time token embedded in that link
 * (handled automatically by detectSessionInUrl on the client) — by the
 * time this component mounts, a live session already exists for the
 * invited email. There is no password on the account yet, so this
 * screen's only job is to set one via updateUser({ password }).
 *
 * After a successful password set, we sign the user out and send them
 * to /login — matching the existing pattern (StaffSignupScreen's old
 * success flow, ResetPasswordScreen) rather than trying to route them
 * straight into the console from here.
 */
export default function StaffCompleteSignupScreen() {
  const navigate = useNavigate();
  const [checking, setChecking] = useState(true);
  const [sessionOk, setSessionOk] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (cancelled) return;
      if (session?.user) {
        setSessionOk(true);
        setEmail(session.user.email || "");
      }
      setChecking(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy) return;
    setError("");
    if (!password || password.length < 8) {
      setError("Choose a password of at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({
        password,
      });
      if (updateError) throw updateError;
      await supabase.auth.signOut();
      setDone(true);
    } catch (err) {
      setError(
        err?.message || "Could not set your password. Try the link again.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (checking) {
    return (
      <div className="app-shell flex flex-col items-center justify-center">
        <p className="text-[13px] text-slate-500">Checking your invite…</p>
      </div>
    );
  }

  if (!sessionOk) {
    return (
      <div className="app-shell flex flex-col">
        <div className="flex items-center px-5 pt-5 pb-4">
          <img src="/images/Logo1.png" alt="GoldenWay" className="h-6 w-auto" />
        </div>
        <div className="flex-1 px-7 pt-4 pb-8 text-center mt-10">
          <h1 className="font-display text-2xl font-bold text-ink-900">
            Link expired
          </h1>
          <p className="text-slate-500 text-[14px] mt-3 leading-relaxed">
            This invite link is no longer valid — it may have already been used,
            or it's expired. Ask a GoldenWay admin to re-approve your request if
            needed.
          </p>
          <button
            type="button"
            onClick={() => navigate("/login")}
            className="mt-8 w-full btn-gold py-4 text-[15px]"
          >
            Back to Sign In
          </button>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="app-shell flex flex-col">
        <div className="flex items-center px-5 pt-5 pb-4">
          <img src="/images/Logo1.png" alt="GoldenWay" className="h-6 w-auto" />
        </div>
        <div className="flex-1 px-7 pt-4 pb-8 text-center mt-10">
          <h1 className="font-display text-2xl font-bold text-ink-900">
            You're all set
          </h1>
          <p className="text-slate-500 text-[14px] mt-3 leading-relaxed">
            Your password is set. Sign in with{" "}
            <span className="font-semibold text-ink-700">{email}</span> to get
            into the staff console.
          </p>
          <button
            type="button"
            onClick={() => navigate("/login")}
            className="mt-8 w-full btn-gold py-4 text-[15px]"
          >
            Go to Sign In
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell flex flex-col">
      <div className="flex items-center px-5 pt-5 pb-4">
        <img src="/images/Logo1.png" alt="GoldenWay" className="h-6 w-auto" />
      </div>
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45 }}
        className="flex-1 px-7 pt-4 pb-8"
      >
        <h1 className="font-display text-2xl font-bold text-ink-900 text-center">
          Set your password
        </h1>
        <p className="text-slate-500 text-[14px] text-center mt-2 leading-relaxed">
          Finishing setup for{" "}
          <span className="font-semibold text-ink-700">{email}</span>
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4 mt-7">
          {error && (
            <div
              role="alert"
              className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[12px] font-medium text-red-600"
            >
              {error}
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <label className="text-[13px] font-medium text-ink-700">
              Password
            </label>
            <div className="field-shell">
              <input
                type="password"
                placeholder="At least 8 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                className="w-full py-3.5 text-[15px] text-ink-900 placeholder:text-slate-400 bg-transparent outline-none"
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[13px] font-medium text-ink-700">
              Confirm Password
            </label>
            <div className="field-shell">
              <input
                type="password"
                placeholder="Repeat your password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                className="w-full py-3.5 text-[15px] text-ink-900 placeholder:text-slate-400 bg-transparent outline-none"
              />
            </div>
          </div>
          <motion.button
            whileTap={{ scale: 0.97 }}
            type="submit"
            disabled={busy}
            className="mt-2 w-full btn-gold py-4 text-[15px] disabled:opacity-60"
          >
            {busy ? "Saving…" : "Set password & finish"}
          </motion.button>
        </form>
      </motion.div>
    </div>
  );
}
