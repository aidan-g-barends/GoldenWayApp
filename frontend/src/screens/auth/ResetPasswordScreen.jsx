import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { updateMyPassword } from "../../api/auth";
import { supabase } from "../../lib/supabaseClient";

/**
 * Reset Password — destination of the Supabase recovery email link.
 * supabase-js consumes the recovery token (detectSessionInUrl) and
 * establishes a session before this screen mounts; we verify that
 * session exists before showing the form, same pattern as
 * StaffCompleteSignupScreen for the invite flow.
 */
export default function ResetPasswordScreen() {
  const navigate = useNavigate();
  const [checking, setChecking] = useState(true);
  const [sessionOk, setSessionOk] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!cancelled) {
        setSessionOk(!!session);
        setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const weak = password.length > 0 && password.length < 8;
  const mismatch = confirm.length > 0 && confirm !== password;
  const invalid = password.length < 8 || confirm !== password;

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy || invalid) return;
    setError("");
    setBusy(true);
    try {
      await updateMyPassword(password);
      await supabase.auth.signOut();
      navigate("/login", { replace: true, state: { resetDone: true } });
    } catch (err) {
      setError(
        err?.message ||
          "Could not update the password. The link may have expired — request a new one.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (checking) {
    return (
      <div className="app-shell flex flex-col items-center justify-center">
        <p className="text-[13px] text-slate-500">Checking your link…</p>
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
            This password reset link is no longer valid — it may have already
            been used, or it's expired. Request a new one from the sign-in
            screen.
          </p>
          <button
            type="button"
            onClick={() => navigate("/forgot-password")}
            className="mt-8 w-full btn-gold py-4 text-[15px]"
          >
            Request a new link
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
        className="flex-1 px-7 pt-4"
      >
        <div className="flex justify-center mb-5">
          <img
            src="/images/Logo2.png"
            alt="GoldenWay"
            className="h-16 w-auto"
          />
        </div>

        <h1 className="font-display text-2xl font-bold text-ink-900 text-center">
          Set a New Password
        </h1>
        <p className="text-slate-500 text-[14px] text-center mt-2 leading-relaxed">
          Choose a new password of at least 8 characters.
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

          <PasswordInput
            label="New Password"
            placeholder="At least 8 characters"
            value={password}
            onChange={setPassword}
            show={show}
            onToggle={() => setShow((s) => !s)}
            error={weak ? "Password must be at least 8 characters" : null}
          />

          <PasswordInput
            label="Confirm Password"
            placeholder="Repeat the new password"
            value={confirm}
            onChange={setConfirm}
            show={show}
            onToggle={() => setShow((s) => !s)}
            error={mismatch ? "Passwords do not match" : null}
          />

          <motion.button
            whileTap={{ scale: 0.97 }}
            type="submit"
            disabled={busy || invalid}
            className="mt-2 w-full btn-gold py-4 text-[15px] disabled:opacity-60"
          >
            {busy ? "Saving…" : "Save New Password"}
          </motion.button>
        </form>
      </motion.div>
    </div>
  );
}

function PasswordInput({
  label,
  placeholder,
  value,
  onChange,
  show,
  onToggle,
  error,
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[13px] font-medium text-ink-700">{label}</label>
      <div className="field-shell">
        <input
          type={show ? "text" : "password"}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="new-password"
          className="w-full py-3.5 text-[15px] text-ink-900 placeholder:text-slate-400 bg-transparent outline-none"
        />
        <button
          type="button"
          onClick={onToggle}
          className="text-slate-500 shrink-0 text-[12px] font-medium"
          aria-label={show ? "Hide password" : "Show password"}
        >
          {show ? "Hide" : "Show"}
        </button>
      </div>
      {error && <p className="text-[11px] text-red-600">{error}</p>}
    </div>
  );
}
