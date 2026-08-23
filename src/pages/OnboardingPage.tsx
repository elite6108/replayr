import { FormEvent, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { APP_NAME } from "../branding";
import { AuthCard } from "../components/common/AuthCard";
import { useAuthStore } from "../stores/authStore";
import { useSettingsStore } from "../stores/settingsStore";
import { validateUsername } from "../utils/username";
import type { AppSettings } from "../types/settings";

const STEPS = ["Welcome", "Account", "Quality", "Length", "Microphone", "Save folder", "Hotkey", "Startup", "Done"] as const;

export function OnboardingPage() {
  const [step, setStep] = useState(0);
  const settings = useSettingsStore((state) => state.settings);
  const patch = useSettingsStore((state) => state.patch);
  const configured = useAuthStore((state) => state.configured);
  const user = useAuthStore((state) => state.user);
  const profile = useAuthStore((state) => state.profile);
  const saveProfile = useAuthStore((state) => state.saveProfile);

  const [username, setUsername] = useState(profile?.username ?? "");
  const [authError, setAuthError] = useState<string | null>(null);

  async function finish() {
    await patch({ onboardingCompleted: true });
  }

  async function chooseFolder() {
    const selected = await open({ directory: true, multiple: false, title: "Choose clip save location" });
    if (typeof selected === "string") await patch({ saveLocation: selected });
  }

  async function saveUsername(event: FormEvent) {
    event.preventDefault();
    const message = validateUsername(username);
    if (message) {
      setAuthError(message);
      return;
    }
    await saveProfile({ username: username.trim(), display_name: username.trim() });
    setStep(2);
  }

  return (
    <div className="onboarding-shell">
      <div className="onboarding panel stack">
        <div className="nav-brand onboarding-mark">
          Replay
        </div>
        <div className="muted">{STEPS[step]}</div>
        <div className="steps" aria-hidden="true">
          {STEPS.map((label, index) => (
            <div key={label} className={index <= step ? "step-pip active" : "step-pip"} />
          ))}
        </div>

        {step === 0 ? (
          <>
            <h1>Welcome to {APP_NAME}</h1>
            <p className="muted">Clip gameplay on this PC, then sign in to keep a cloud copy. Recording and Instant Replay are already live.</p>
            <div className="row">
              <button className="btn primary" type="button" onClick={() => setStep(1)}>
                Continue
              </button>
              <button className="btn" type="button" onClick={() => void finish()}>
                Skip for now
              </button>
            </div>
          </>
        ) : null}

        {step === 1 ? (
          <>
            <h1>Account</h1>
            {!configured ? (
              <p className="muted">Supabase is not configured yet. You can skip and use the app locally.</p>
            ) : user ? (
              profile?.username ? (
                <p>Signed in as {profile.username}.</p>
              ) : (
                <form className="stack" onSubmit={(event) => void saveUsername(event)}>
                  <p>Choose a unique username. Clip links will not include this name.</p>
                  <div className="field">
                    <label htmlFor="onboard-username">Username</label>
                    <input id="onboard-username" value={username} onChange={(event) => setUsername(event.target.value)} />
                  </div>
                  {authError ? <div className="error-text">{authError}</div> : null}
                  <button className="btn primary" type="submit">
                    Save username
                  </button>
                </form>
              )
            ) : (
              <AuthCard compact />
            )}
            <div className="row">
              <button className="btn" type="button" onClick={() => setStep(2)}>
                Skip account
              </button>
              {user && profile?.username ? (
                <button className="btn primary" type="button" onClick={() => setStep(2)}>
                  Next
                </button>
              ) : null}
            </div>
          </>
        ) : null}

        {step === 2 ? (
          <>
            <h1>Recording quality</h1>
            <p className="muted">Saved for later. Nothing is recorded yet.</p>
            <div className="field">
              <label htmlFor="onboard-res">Resolution</label>
              <select
                id="onboard-res"
                value={settings.resolution}
                onChange={(event) => void patch({ resolution: event.target.value as AppSettings["resolution"] })}
              >
                <option value="native">Native</option>
                <option value="1080p">1080p</option>
                <option value="720p">720p</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="onboard-fps">FPS</label>
              <select
                id="onboard-fps"
                value={settings.fps}
                onChange={(event) => void patch({ fps: Number(event.target.value) as AppSettings["fps"] })}
              >
                <option value={30}>30</option>
                <option value={60}>60</option>
                <option value={120}>120</option>
              </select>
            </div>
            <button className="btn primary" type="button" onClick={() => setStep(3)}>
              Next
            </button>
          </>
        ) : null}

        {step === 3 ? (
          <>
            <h1>Clip length</h1>
            <div className="field">
              <label htmlFor="onboard-len">Instant Replay length</label>
              <select
                id="onboard-len"
                value={settings.replayDurationSeconds}
                onChange={(event) =>
                  void patch({ replayDurationSeconds: Number(event.target.value) as AppSettings["replayDurationSeconds"] })
                }
              >
                <option value={15}>15 seconds</option>
                <option value={30}>30 seconds</option>
                <option value={60}>60 seconds</option>
                <option value={120}>2 minutes</option>
                <option value={300}>5 minutes</option>
              </select>
            </div>
            <button className="btn primary" type="button" onClick={() => setStep(4)}>
              Next
            </button>
          </>
        ) : null}

        {step === 4 ? (
          <>
            <h1>Microphone</h1>
            <label className="row">
              <input
                type="checkbox"
                checked={settings.micEnabled}
                onChange={(event) => void patch({ micEnabled: event.target.checked })}
              />
              Record microphone when capture exists
            </label>
            <p className="muted">Device selection arrives with the recording engine.</p>
            <button className="btn primary" type="button" onClick={() => setStep(5)}>
              Next
            </button>
          </>
        ) : null}

        {step === 5 ? (
          <>
            <h1>Save location</h1>
            <p>{settings.saveLocation || "Default Videos folder"}</p>
            <div className="row">
              <button className="btn" type="button" onClick={() => void chooseFolder()}>
                Choose folder
              </button>
              <button className="btn primary" type="button" onClick={() => setStep(6)}>
                Next
              </button>
            </div>
          </>
        ) : null}

        {step === 6 ? (
          <>
            <h1>Hotkey</h1>
            <p>
              Save Replay is <kbd>{settings.hotkeys.saveReplay}</kbd>. It saves the Instant Replay buffer.
            </p>
            <button className="btn primary" type="button" onClick={() => setStep(7)}>
              Next
            </button>
          </>
        ) : null}

        {step === 7 ? (
          <>
            <h1>Startup</h1>
            <label className="row">
              <input
                type="checkbox"
                checked={settings.launchAtStartup}
                onChange={(event) => void patch({ launchAtStartup: event.target.checked })}
              />
              Launch {APP_NAME} when Windows starts
            </label>
            <button className="btn primary" type="button" onClick={() => setStep(8)}>
              Next
            </button>
          </>
        ) : null}

        {step === 8 ? (
          <>
            <h1>You are set</h1>
            <p>The desktop shell is ready. Detection works. Recording, uploads, and share links come next.</p>
            <button className="btn primary" type="button" onClick={() => void finish()}>
              Open {APP_NAME}
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
