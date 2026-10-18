import React, { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Mail, Lock, ShieldCheck, AlertCircle, ArrowLeft, KeyRound, CheckCircle2 } from "lucide-react";
import { getApiErrorMessage, getApiErrorStatus } from "../../Interfaces/http";
import { getApiErrorCode, login, sendOtp, setupPassword, verifyOtp } from "../../Interfaces/authApi";
import { useAuth } from "../common/AuthContext";
import { redirectTargetFromState } from "../common/RouteGuards";
import { PasswordInput, PasswordRules, staffPasswordRules } from "../common/PasswordInput";
import { Spinner } from "../common/Spinner";

/**
 * Staff sign-in.
 *  - Email + password → /auth/login → signInWithCustomToken.
 *  - "Forgot / set password": email → 6-digit OTP → new password → /auth/setup-password (signs in).
 *    Also used automatically if the server answers `password_setup_required` (older backends; current
 *    ones return a generic 401, so the 401 message points first-time users to "Forgot / set password").
 */

type Step = "login" | "email" | "otp" | "password";
type ResetMode = "forgot" | "setup";

const RESEND_COOLDOWN_S = 30;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const inputBase =
  "w-full min-h-[48px] py-3 border border-gray-200 rounded-full focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 transition-all duration-300 text-gray-900 placeholder-gray-400 font-medium outline-none bg-gray-50/50 focus:bg-white text-base disabled:opacity-60";
const primaryBtn =
  "w-full min-h-[48px] bg-indigo-600 hover:bg-indigo-700 text-white py-3.5 px-6 rounded-full font-bold text-sm sm:text-base transition-all duration-300 shadow-lg disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2 focus:outline-none focus-visible:ring-4 focus-visible:ring-indigo-200";
const linkBtn =
  "text-sm font-semibold text-indigo-600 hover:text-indigo-800 transition-colors disabled:text-gray-400 disabled:cursor-not-allowed min-h-[40px] px-1";

/** Firebase client errors (signInWithCustomToken) carry technical messages. */
const friendlyError = (err: unknown, fallback?: string): string => {
  const msg = getApiErrorMessage(err, fallback);
  if (/firebase|auth\//i.test(msg)) {
    return /network/i.test(msg)
      ? "Network error while starting your session. Please check your connection and try again."
      : "We couldn't start your session. Please try again.";
  }
  return msg;
};

const ErrorBox = ({ id, message }: { id: string; message: string }) =>
  message ? (
    <div id={id} role="alert" className="p-3 bg-red-50 border border-red-100 rounded-2xl flex items-start gap-2">
      <AlertCircle className="h-4 w-4 text-red-500 mt-0.5 flex-shrink-0" aria-hidden="true" />
      <p className="text-red-700 text-sm font-medium">{message}</p>
    </div>
  ) : null;

const InfoBox = ({ message }: { message: string }) =>
  message ? (
    <div role="status" className="p-3 bg-indigo-50 border border-indigo-100 rounded-2xl flex items-start gap-2">
      <CheckCircle2 className="h-4 w-4 text-indigo-600 mt-0.5 flex-shrink-0" aria-hidden="true" />
      <p className="text-indigo-900 text-sm">{message}</p>
    </div>
  ) : null;

const FieldLabel = ({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) => (
  <label htmlFor={htmlFor} className="block text-xs font-bold text-gray-600 uppercase ml-3 mb-1.5">
    {children}
  </label>
);

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { completeSignIn } = useAuth();

  const [step, setStep] = useState<Step>("login");
  const [resetMode, setResetMode] = useState<ResetMode>("forgot");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  // Login
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // Reset / setup
  const [resetEmail, setResetEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [cooldown, setCooldown] = useState(0);

  const emailRef = useRef<HTMLInputElement>(null);
  const resetEmailRef = useRef<HTMLInputElement>(null);
  const otpRef = useRef<HTMLInputElement>(null);
  const newPwdRef = useRef<HTMLInputElement>(null);

  // Resend cooldown ticker (cleaned up on unmount).
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = window.setTimeout(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => window.clearTimeout(t);
  }, [cooldown]);

  // Move focus to the first field of each step.
  useEffect(() => {
    const target =
      step === "login" ? emailRef : step === "email" ? resetEmailRef : step === "otp" ? otpRef : newPwdRef;
    const id = window.setTimeout(() => target.current?.focus(), 50);
    return () => window.clearTimeout(id);
  }, [step]);

  const goTo = (next: Step) => {
    setError("");
    setStep(next);
  };

  const finishSignIn = async (result: Awaited<ReturnType<typeof login>>) => {
    await completeSignIn(result);
    navigate(redirectTargetFromState(location.state), { replace: true });
  };

  // ---------------------------------------------------------------- login
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError("");
    setInfo("");
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setError("Please enter a valid email address.");
      return;
    }
    if (!password) {
      setError("Please enter your password.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await login(trimmed, password);
      await finishSignIn(result);
    } catch (err) {
      if (getApiErrorCode(err) === "password_setup_required") {
        setResetMode("setup");
        setResetEmail(trimmed);
        setPassword("");
        setInfo("You haven't set a password yet. We'll email you a 6-digit code to confirm it's you.");
        goTo("email");
      } else if (getApiErrorStatus(err) === 401) {
        // Wrong credentials OR a password that was never set (the server answers both with the same
        // generic 401 so it can't be used to discover accounts).
        setError("Invalid email or password. First time? Use 'Forgot / set password' to set your password.");
      } else {
        setError(friendlyError(err, "Sign-in failed. Please try again."));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const startReset = () => {
    setResetMode("forgot");
    setResetEmail(email.trim());
    setOtp("");
    setResetToken("");
    setNewPassword("");
    setConfirmPassword("");
    setInfo("");
    goTo("email");
  };

  const backToLogin = () => {
    setInfo("");
    setOtp("");
    setResetToken("");
    setNewPassword("");
    setConfirmPassword("");
    if (resetEmail) setEmail(resetEmail);
    goTo("login");
  };

  // ---------------------------------------------------------------- OTP
  const requestOtp = async (): Promise<boolean> => {
    const trimmed = resetEmail.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setError("Please enter a valid email address.");
      return false;
    }
    setSubmitting(true);
    setError("");
    try {
      await sendOtp(trimmed);
      setCooldown(RESEND_COOLDOWN_S);
      setInfo(`If ${trimmed} belongs to a staff account, a 6-digit code has been sent. It expires in 10 minutes.`);
      return true;
    } catch (err) {
      setError(friendlyError(err, "Couldn't send the code. Please try again."));
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  const handleSendOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (await requestOtp()) {
      setOtp("");
      goTo("otp");
    }
  };

  const handleResend = async () => {
    if (submitting || cooldown > 0) return;
    setOtp("");
    await requestOtp();
    otpRef.current?.focus();
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (!/^\d{6}$/.test(otp)) {
      setError("Please enter the 6-digit code from the email.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const { resetToken: token } = await verifyOtp(resetEmail.trim(), otp);
      setResetToken(token);
      setInfo("");
      goTo("password");
    } catch (err) {
      setError(friendlyError(err, "That code didn't work. Please try again or request a new one."));
    } finally {
      setSubmitting(false);
    }
  };

  // ---------------------------------------------------------------- new password
  const rules = staffPasswordRules(newPassword);
  const rulesOk = rules.every((r) => r.ok);
  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;

  const handleSetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError("");
    if (!rulesOk) {
      setError("Your password must be at least 8 characters and include letters and numbers.");
      return;
    }
    if (newPassword.length > 128) {
      setError("Your password must be at most 128 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("The passwords don't match.");
      return;
    }
    if (!resetToken) {
      setError("Your verification has expired. Please request a new code.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await setupPassword(resetEmail.trim(), resetToken, newPassword);
      await finishSignIn(result);
    } catch (err) {
      setError(friendlyError(err, "Couldn't set your password. Please request a new code and try again."));
    } finally {
      setSubmitting(false);
    }
  };

  // ---------------------------------------------------------------- render
  const resetTitle = resetMode === "setup" ? "Set your password" : "Reset your password";
  const heading =
    step === "login"
      ? "Agent Login"
      : step === "password"
        ? "Choose a new password"
        : resetTitle;
  const subheading =
    step === "login"
      ? "Sign in to access your Returns Admin dashboard"
      : step === "email"
        ? "Enter your work email to receive a 6-digit verification code"
        : step === "otp"
          ? "Enter the 6-digit code we emailed you"
          : "Create a secure password for your account";

  return (
    <div
      className="min-h-screen min-h-dvh flex flex-col lg:flex-row bg-cover bg-center lg:bg-left-top relative overflow-x-hidden"
      style={{ backgroundImage: "url('/prashanti_returns_bg.png')" }}
    >
      {/* Overlay */}
      <div className="absolute inset-0 bg-gradient-to-br from-black/70 via-indigo-950/40 to-indigo-900/50" aria-hidden="true" />

      {/* Brand */}
      <div className="relative z-10 lg:flex-[0.5] flex flex-col justify-center px-5 sm:px-8 lg:px-12 pt-10 pb-6 lg:py-0 text-left">
        <h1 className="text-3xl sm:text-5xl lg:text-7xl font-black text-white mb-2 lg:mb-6 drop-shadow-2xl tracking-wide leading-tight break-words">
          Prashanti Sarees
        </h1>
        <p className="text-base sm:text-xl lg:text-3xl text-white/90 drop-shadow-lg font-light tracking-wide mb-3 lg:mb-6">
          Returns Admin Portal
        </p>
        <div className="w-20 sm:w-24 lg:w-32 h-1 bg-gradient-to-r from-indigo-300 to-white/70 rounded-full" aria-hidden="true" />
      </div>

      {/* Card */}
      <main className="relative z-10 flex-1 lg:flex-[0.5] flex items-start lg:items-center justify-center px-3 sm:px-6 lg:px-8 pb-10 lg:py-0">
        <div className="relative bg-white/95 backdrop-blur-xl rounded-2xl sm:rounded-3xl shadow-2xl px-5 sm:px-8 py-7 sm:py-10 border border-white/20 w-full max-w-md">
          {step !== "login" && (
            <button
              type="button"
              onClick={step === "password" || step === "email" ? backToLogin : () => goTo("email")}
              disabled={submitting}
              className="absolute left-2 top-2 sm:left-3 sm:top-3 h-10 px-3 flex items-center gap-1 text-sm font-medium text-gray-500 hover:text-gray-800 hover:bg-gray-100 rounded-full transition-colors disabled:opacity-50"
            >
              <ArrowLeft className="w-4 h-4" aria-hidden="true" />
              Back
            </button>
          )}

          <div className="text-center mb-6 mt-4 sm:mt-2">
            {step !== "login" && (
              <div className="w-12 h-12 bg-indigo-100 text-indigo-600 rounded-full flex items-center justify-center mb-3 mx-auto" aria-hidden="true">
                {step === "password" ? <ShieldCheck className="w-6 h-6" /> : step === "otp" ? <KeyRound className="w-6 h-6" /> : <Mail className="w-6 h-6" />}
              </div>
            )}
            <h2 className="text-2xl sm:text-3xl font-bold text-gray-800 mb-2">{heading}</h2>
            <p className="text-gray-500 text-sm">{subheading}</p>
            <div className="w-12 h-1 bg-indigo-600 mx-auto rounded-full mt-4" aria-hidden="true" />
          </div>

          {/* ---------- LOGIN ---------- */}
          {step === "login" && (
            <form onSubmit={handleLogin} className="space-y-4 sm:space-y-5" noValidate>
              <div>
                <FieldLabel htmlFor="login-email">Email Address</FieldLabel>
                <div className="relative">
                  <input
                    id="login-email"
                    ref={emailRef}
                    type="email"
                    name="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className={`${inputBase} pl-11 pr-4`}
                    placeholder="you@prashantisarees.com"
                    required
                    autoComplete="username"
                    inputMode="email"
                    autoCapitalize="none"
                    spellCheck={false}
                    disabled={submitting}
                    aria-invalid={!!error}
                    aria-describedby={error ? "login-error" : undefined}
                  />
                  <Mail className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400 pointer-events-none" aria-hidden="true" />
                </div>
              </div>

              <div>
                <FieldLabel htmlFor="login-password">Password</FieldLabel>
                <PasswordInput
                  id="login-password"
                  name="password"
                  value={password}
                  onChange={setPassword}
                  inputClassName={`${inputBase} pl-11`}
                  leftIcon={<Lock className="h-5 w-5 ml-1" />}
                  placeholder="Enter your password"
                  required
                  autoComplete="current-password"
                  disabled={submitting}
                  aria-invalid={!!error}
                  aria-describedby={error ? "login-error" : undefined}
                />
                <div className="flex justify-end pt-1">
                  <button type="button" onClick={startReset} disabled={submitting} className={linkBtn}>
                    Forgot / set password?
                  </button>
                </div>
              </div>

              <InfoBox message={info} />
              <ErrorBox id="login-error" message={error} />

              <button type="submit" disabled={submitting} className={primaryBtn}>
                {submitting ? (
                  <>
                    <Spinner className="w-5 h-5" />
                    <span>Signing in…</span>
                  </>
                ) : (
                  "Sign In to Dashboard"
                )}
              </button>

              <p className="text-center text-xs text-gray-500 mt-4">
                Secure agent portal for Prashanti Sarees staff only
              </p>
            </form>
          )}

          {/* ---------- EMAIL (send OTP) ---------- */}
          {step === "email" && (
            <form onSubmit={handleSendOtp} className="space-y-4" noValidate>
              <div>
                <FieldLabel htmlFor="reset-email">Email Address</FieldLabel>
                <div className="relative">
                  <input
                    id="reset-email"
                    ref={resetEmailRef}
                    type="email"
                    name="email"
                    value={resetEmail}
                    onChange={(e) => setResetEmail(e.target.value)}
                    className={`${inputBase} pl-11 pr-4`}
                    placeholder="you@prashantisarees.com"
                    required
                    autoComplete="username"
                    inputMode="email"
                    autoCapitalize="none"
                    spellCheck={false}
                    disabled={submitting}
                    aria-invalid={!!error}
                    aria-describedby={error ? "reset-email-error" : undefined}
                  />
                  <Mail className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400 pointer-events-none" aria-hidden="true" />
                </div>
              </div>

              <InfoBox message={info} />
              <ErrorBox id="reset-email-error" message={error} />

              <button type="submit" disabled={submitting} className={primaryBtn}>
                {submitting ? (
                  <>
                    <Spinner className="w-5 h-5" />
                    <span>Sending code…</span>
                  </>
                ) : (
                  "Send verification code"
                )}
              </button>
            </form>
          )}

          {/* ---------- OTP ---------- */}
          {step === "otp" && (
            <form onSubmit={handleVerifyOtp} className="space-y-4" noValidate>
              <div>
                <FieldLabel htmlFor="reset-otp">Verification code</FieldLabel>
                <input
                  id="reset-otp"
                  ref={otpRef}
                  type="text"
                  name="otp"
                  maxLength={6}
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  className={`${inputBase} px-4 text-center text-2xl tracking-[0.5em] font-bold placeholder:text-gray-300 placeholder:tracking-[0.3em]`}
                  placeholder="••••••"
                  required
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  disabled={submitting}
                  aria-invalid={!!error}
                  aria-describedby={`reset-otp-help${error ? " reset-otp-error" : ""}`}
                />
                <p id="reset-otp-help" className="text-xs text-gray-500 text-center mt-2 break-words">
                  Sent to <strong className="text-gray-700">{resetEmail.trim()}</strong>
                </p>
              </div>

              <InfoBox message={info} />
              <ErrorBox id="reset-otp-error" message={error} />

              <button type="submit" disabled={submitting || otp.length !== 6} className={primaryBtn}>
                {submitting ? (
                  <>
                    <Spinner className="w-5 h-5" />
                    <span>Verifying…</span>
                  </>
                ) : (
                  "Verify code"
                )}
              </button>

              <div className="text-center">
                <button
                  type="button"
                  onClick={handleResend}
                  disabled={cooldown > 0 || submitting}
                  className={linkBtn}
                  aria-live="polite"
                >
                  {cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend code"}
                </button>
              </div>
            </form>
          )}

          {/* ---------- NEW PASSWORD ---------- */}
          {step === "password" && (
            <form onSubmit={handleSetPassword} className="space-y-4" noValidate>
              {/* Hidden username field so password managers save the right account. */}
              <input type="email" name="username" value={resetEmail} autoComplete="username" readOnly hidden />

              <div>
                <FieldLabel htmlFor="new-password">New password</FieldLabel>
                <PasswordInput
                  id="new-password"
                  name="new-password"
                  inputRef={newPwdRef}
                  value={newPassword}
                  onChange={setNewPassword}
                  inputClassName={`${inputBase} pl-5`}
                  placeholder="At least 8 characters"
                  required
                  minLength={8}
                  maxLength={128}
                  autoComplete="new-password"
                  disabled={submitting}
                  aria-describedby="new-password-rules"
                />
              </div>

              <PasswordRules id="new-password-rules" rules={rules} />

              <div>
                <FieldLabel htmlFor="confirm-password">Confirm password</FieldLabel>
                <PasswordInput
                  id="confirm-password"
                  name="confirm-password"
                  value={confirmPassword}
                  onChange={setConfirmPassword}
                  inputClassName={`${inputBase} pl-5`}
                  placeholder="Re-enter the password"
                  required
                  autoComplete="new-password"
                  disabled={submitting}
                  aria-invalid={mismatch}
                  aria-describedby={mismatch ? "confirm-mismatch" : undefined}
                />
                {mismatch && (
                  <p id="confirm-mismatch" className="text-xs text-red-600 mt-1.5 ml-3">
                    The passwords don't match.
                  </p>
                )}
              </div>

              <ErrorBox id="set-password-error" message={error} />

              <button
                type="submit"
                disabled={submitting || !rulesOk || !confirmPassword || mismatch}
                className={primaryBtn}
              >
                {submitting ? (
                  <>
                    <Spinner className="w-5 h-5" />
                    <span>Saving…</span>
                  </>
                ) : (
                  "Set password & sign in"
                )}
              </button>

              {error && (
                <div className="text-center">
                  <button type="button" onClick={() => goTo("email")} disabled={submitting} className={linkBtn}>
                    Request a new code
                  </button>
                </div>
              )}
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
