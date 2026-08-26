import { useEffect, useRef, useState } from "react";
import { comboFromKeyboardEvent } from "../../utils/hotkeys";
import { displayHotkey } from "../../utils/format";

export function HotkeyRecorder({
  id,
  value,
  onChange,
  disabled,
}: {
  id?: string;
  value: string;
  onChange: (next: string) => void | Promise<void>;
  disabled?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [listening, setListening] = useState(false);
  const [pending, setPending] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    if (!listening) return;

    function onKeyDown(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        setListening(false);
        setHint(null);
        return;
      }

      if (event.key === "Backspace" || event.key === "Delete") {
        setListening(false);
        setHint(null);
        void Promise.resolve(onChange("")).catch(() => {
          setHint("Could not clear that shortcut.");
        });
        return;
      }

      const combo = comboFromKeyboardEvent(event);
      if (!combo) {
        setHint("That key isn’t supported. Try another.");
        return;
      }

      setListening(false);
      setHint(null);
      setPending(true);
      void Promise.resolve(onChange(combo))
        .catch((caught) => {
          setHint(caught instanceof Error ? caught.message : "Could not save that shortcut.");
        })
        .finally(() => setPending(false));
    }

    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setListening(false);
        setHint(null);
      }
    }

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [listening, onChange]);

  return (
    <div className="hotkey-recorder" ref={rootRef}>
      <button
        id={id}
        type="button"
        className={`hotkey-recorder-btn${listening ? " listening" : ""}`}
        disabled={disabled || pending}
        aria-pressed={listening}
        onClick={() => {
          if (disabled || pending) return;
          setHint(null);
          setListening((open) => !open);
        }}
      >
        {listening ? "Press keys…" : displayHotkey(value) || "Click to set"}
      </button>
      {hint ? <span className="error-text">{hint}</span> : null}
      {listening ? <span className="muted">Esc cancels · Backspace clears</span> : null}
    </div>
  );
}
