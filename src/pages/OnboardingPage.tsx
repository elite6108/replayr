import { FormEvent, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import logoWordmark from "../assets/replayr-logo.png";
import { APP_NAME } from "../branding";
import { AuthCard } from "../components/common/AuthCard";
import { useAuthStore } from "../stores/authStore";
import { useSettingsStore } from "../stores/settingsStore";
import { validateUsername } from "../utils/username";
import type { AppSettings } from "../types/settings";
import { MicrophoneControls } from "../components/settings/MicrophoneControls";
import { WindowControls } from "../components/layout/WindowChrome";
import { getCurrentWindow } from "@tauri-apps/api/window";

const STEPS = ["Welcome", "Account", "Quality", "Length", "Microphone", "Save folder", "Hotkey", "Startup", "Done"] as const;

export function OnboardingPage() {
  const [step, setStep] = useState(0);
  const settings = useSettingsStore((state) => state.settings);
  const patch = useSettingsStore((state) => state.patch);
  const configured = useAuthStore((state) => state.configured);
  const user = useAuthStore((state) => state.user);
  const profile = useAuthStore((state) => state.profile);
  const saveProfile = useAuthStore((state) => state.saveProfile);
  const refreshProfile = useAuthStore((state) => state.refreshProfile);

  const [username, setUsername] = useState(profile?.username ?? "");
  const [authError, setAuthError] = useState<string | null>(null);
  const [accountChecked, setAccountChecked] = useState(false);

  async function finish() {
    const current = useSettingsStore.getState().settings;
    useSettingsStore.setState({
      settings: { ...current, onboardingCompleted: true, desktopShortcutPrompted: true },
    });
    void patch({ onboardingCompleted: true, desktopShortcutPrompted: true }).catch(() => undefined);
  }

  useEffect(() => {
    if (profile?.username) setUsername(profile.username);
  }, [profile?.username]);

  useEffect(() => {
    if (!user?.id) {
      setAccountChecked(false);
      return;
    }
    let cancelled = false;
    setAccountChecked(false);
    void refreshProfile()
      .catch(() => undefined)
      .finally(() => {
        if (cancelled) return;
        if (useAuthStore.getState().profile?.username) {
          void finish();
          return;
        }
        setAccountChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id, refreshProfile]);

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
      <header className="titlebar-slim" data-tauri-drag-region onDoubleClick={() => void getCurrentWindow().toggleMaximize()}>
        <WindowControls />
      </header>
      <div className="onboarding-body">
      <div className="onboarding panel stack">
        <div className="nav-brand onboarding-mark">
          <img src={logoWordmark} alt={APP_NAME} />
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
            ) : user && !accountChecked ? (
              <p className="muted">Loading your account…</p>
            ) : user ? (
              profile?.username ? (
                <p>Signed in as {profile.username}. Opening {APP_NAME}…</p>
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
              <button className="btn" type="button" onClick={() => void finish()}>
                Open {APP_NAME}
              </button>
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
            <h1>Include your microphone in clips?</h1>
            <p className="muted">Replayr will not record your mic until you opt in. You can change this later in Settings.</p>
            <div className="row">
              <button
                className={settings.micEnabled ? "btn primary" : "btn"}
                type="button"
                onClick={() => void patch({ micEnabled: true })}
              >
                Yes, include my microphone
              </button>
              <button
                className={!settings.micEnabled ? "btn primary" : "btn"}
                type="button"
                onClick={() => void patch({ micEnabled: false })}
              >
                No, not now
              </button>
            </div>
            {settings.micEnabled ? (
              <MicrophoneControls
                enabled
                compact
                deviceId={settings.microphoneId}
                gain={settings.micGain}
                onEnabled={(enabled) => void patch({ micEnabled: enabled })}
                onDeviceId={(deviceId) => void patch({ microphoneId: deviceId })}
                onGain={(gain) => void patch({ micGain: gain })}
              />
            ) : null}
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
            <label className="row">
              <input
                type="checkbox"
                checked={settings.desktopShortcut}
                onChange={(event) => void patch({ desktopShortcut: event.target.checked })}
              />
              Add {APP_NAME} to the desktop
            </label>
            <div className="row">
              <button
                className="btn primary"
                type="button"
                onClick={() => {
                  void patch({ desktopShortcutPrompted: true }).catch(() => undefined);
                  setStep(8);
                }}
              >
                Next
              </button>
              <button className="btn" type="button" onClick={() => void finish()}>
                Open {APP_NAME}
              </button>
            </div>
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
    </div>
  );
}
