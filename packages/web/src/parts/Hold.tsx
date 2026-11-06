import { useEffect, useRef, useState } from "react";

/**
 * The key's one button: hold it for two seconds to sign; let go sooner and nothing happens. A tap (or Escape) is
 * no. Space or Enter held down works too.
 */
const HOLD_MS = 2000;

export function Hold({ onSign, onRefuse, disabled = false, label = "HOLD" }: { readonly onSign: () => void; readonly onRefuse?: () => void; readonly disabled?: boolean; readonly label?: string }) {
  const [progress, setProgress] = useState(0);
  const started = useRef<number | null>(null);
  const frame = useRef<number | undefined>(undefined);
  const done = useRef(false);

  const stop = (tapped: boolean) => {
    if (started.current === null) return;
    const held = performance.now() - started.current;
    started.current = null;
    window.cancelAnimationFrame(frame.current ?? 0);
    setProgress(0);
    if (!done.current && tapped && held < 300) onRefuse?.();
  };
  const start = () => {
    if (disabled || started.current !== null) return;
    done.current = false;
    started.current = performance.now();
    const step = () => {
      if (started.current === null) return;
      const part = Math.min(1, (performance.now() - started.current) / HOLD_MS);
      setProgress(part);
      if (part >= 1) {
        done.current = true;
        started.current = null;
        setProgress(0);
        navigator.vibrate?.(60);
        onSign();
        return;
      }
      frame.current = window.requestAnimationFrame(step);
    };
    frame.current = window.requestAnimationFrame(step);
  };
  useEffect(() => () => window.cancelAnimationFrame(frame.current ?? 0), []);

  const circumference = 2 * Math.PI * 62;
  return (
    <button
      type="button"
      className={`hold${progress > 0 ? " pressed" : ""}`}
      disabled={disabled}
      aria-label="Hold for two seconds to sign; tap to refuse"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        start();
      }}
      onPointerUp={() => stop(true)}
      onPointerCancel={() => stop(false)}
      onKeyDown={(event) => {
        if ((event.key === " " || event.key === "Enter") && !event.repeat) {
          event.preventDefault();
          start();
        }
        if (event.key === "Escape") onRefuse?.();
      }}
      onKeyUp={(event) => {
        if (event.key === " " || event.key === "Enter") stop(false);
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {label}
      <svg viewBox="0 0 130 130" aria-hidden="true">
        <circle cx="65" cy="65" r="62" fill="none" stroke="rgb(255 255 255 / 10%)" strokeWidth="4" />
        <circle cx="65" cy="65" r="62" fill="none" stroke="#7ee2a8" strokeWidth="4" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - progress)} />
      </svg>
    </button>
  );
}
