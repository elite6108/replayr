import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useAuth } from "../../lib/auth";
import { getSupabase } from "../../lib/supabase";

type GateStage = "loading" | "enroll" | "challenge" | "ready";

type TotpEnrollment = {
  factorId: string;
  qrCode: string;
  secret: string;
};

export function AnalyticsMfaGate({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const [stage, setStage] = useState<GateStage>("loading");
  const [verifiedFactorId, setVerifiedFactorId] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;

    void inspectMfaState()
      .then((result) => {
        if (cancelled) return;
        setVerifiedFactorId(result.factorId);
        setStage(result.stage);
        setError(null);
      })
      .catch((caught) => {
        if (!cancelled) {
          setStage("enroll");
          setError(messageFrom(caught, "Could not check multi-factor authentication."));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [session?.access_token]);

  async function startEnrollment() {
    setBusy(true);
    setError(null);
    try {
      const { data, error: enrollError } = await getSupabase().auth.mfa.enroll({
        factorType: "totp",
        friendlyName: "Replayr admin analytics",
      });
      if (enrollError) throw enrollError;
      setEnrollment({
        factorId: data.id,
        qrCode: data.totp.qr_code,
        secret: data.totp.secret,
      });
      setCode("");
    } catch (caught) {
      setError(messageFrom(caught, "Could not start authenticator setup."));
    } finally {
      setBusy(false);
    }
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    const factorId = enrollment?.factorId ?? verifiedFactorId;
    if (!factorId || !/^\d{6}$/.test(code)) return;

    setBusy(true);
    setError(null);
    try {
      const supabase = getSupabase();
      const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
        factorId,
        code,
      });
      if (verifyError) throw verifyError;

      const { error: refreshError } = await supabase.auth.refreshSession();
      if (refreshError) throw refreshError;

      const { data: assurance, error: assuranceError } =
        await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (assuranceError) throw assuranceError;
      if (assurance.currentLevel !== "aal2") {
        throw new Error("The multi-factor session could not be verified.");
      }

      setEnrollment(null);
      setCode("");
      setStage("ready");
    } catch (caught) {
      setError(messageFrom(caught, "That authentication code could not be verified."));
    } finally {
      setBusy(false);
    }
  }

  if (stage === "ready") return children;

  return (
    <section className="admin-section analytics-page">
      <header className="admin-header">
        <div>
          <p className="eyebrow">Restricted analytics</p>
          <h2>Secure user journeys</h2>
          <p className="muted">
            Verify with an authenticator app before opening named, count-only analytics.
          </p>
        </div>
      </header>

      <div className="admin-panel analytics-mfa-card">
        {stage === "loading" ? <p className="muted">Checking multi-factor authentication…</p> : null}

        {stage === "enroll" && !enrollment ? (
          <>
            <h3>Set up an authenticator</h3>
            <p className="muted">
              Use Google Authenticator, Microsoft Authenticator, Authy, 1Password, or another TOTP app.
            </p>
            <button className="btn primary" type="button" disabled={busy} onClick={() => void startEnrollment()}>
              {busy ? "Starting…" : "Set up authenticator"}
            </button>
          </>
        ) : null}

        {stage === "enroll" && enrollment ? (
          <>
            <h3>Scan this QR code</h3>
            <p className="muted">Add Replayr to your authenticator app, then enter its six-digit code.</p>
            <img className="analytics-mfa-qr" src={enrollment.qrCode} alt="Replayr authenticator QR code" />
            <details>
              <summary>Can’t scan the code?</summary>
              <p className="muted">Enter this setup key manually:</p>
              <code className="analytics-mfa-secret">{enrollment.secret}</code>
            </details>
          </>
        ) : null}

        {stage === "challenge" ? (
          <>
            <h3>Enter your authentication code</h3>
            <p className="muted">Open your authenticator app and enter the current six-digit Replayr code.</p>
          </>
        ) : null}

        {(stage === "challenge" || enrollment) ? (
          <form className="analytics-toolbar" onSubmit={verify}>
            <label>
              Six-digit code
              <input
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                aria-label="Six-digit authentication code"
              />
            </label>
            <button className="btn primary" type="submit" disabled={busy || code.length !== 6}>
              {busy ? "Verifying…" : stage === "challenge" ? "Verify" : "Enable and continue"}
            </button>
          </form>
        ) : null}

        {error ? <p className="error">{error}</p> : null}
      </div>
    </section>
  );
}

async function inspectMfaState(): Promise<{ stage: GateStage; factorId: string | null }> {
  const supabase = getSupabase();
  const { data: assurance, error: assuranceError } =
    await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (assuranceError) throw assuranceError;
  if (assurance.currentLevel === "aal2") {
    return { stage: "ready", factorId: null };
  }

  const { data: factors, error: factorsError } = await supabase.auth.mfa.listFactors();
  if (factorsError) throw factorsError;
  const verified = factors.totp.find((factor) => factor.status === "verified");
  return verified
    ? { stage: "challenge", factorId: verified.id }
    : { stage: "enroll", factorId: null };
}

function messageFrom(caught: unknown, fallback: string): string {
  return caught instanceof Error && caught.message ? caught.message : fallback;
}
