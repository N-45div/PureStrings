import { useEffect, useRef, useSyncExternalStore } from "react";
import { eventsUrl } from "./api.ts";

/**
 * One event stream for the whole app (GET /api/events): screens subscribe and fetch again what they show. After
 * the stream drops and comes back, everyone hears "resync", so nothing that changed in between is missed.
 */

export type Change = { readonly kind: "sign" | "keys" | "agents" | "audit" | "resync" };
export type StreamStatus = "connecting" | "live" | "offline";

const listeners = new Set<(change: Change) => void>();
const statusListeners = new Set<() => void>();
let status: StreamStatus = "connecting";

function setStatus(next: StreamStatus): void {
  if (next === status) return;
  status = next;
  for (const listener of statusListeners) listener();
}

const emit = (change: Change) => {
  for (const listener of listeners) listener(change);
};

/** Opens the stream; returns what closes it. */
export function startEvents(): () => void {
  let source: EventSource | null = null;
  let retry: number | undefined;
  let opened = false;
  let stopped = false;
  const open = () => {
    if (stopped) return;
    setStatus("connecting");
    source = new EventSource(eventsUrl());
    source.addEventListener("change", (message: MessageEvent<string>) => {
      try {
        const change = JSON.parse(message.data) as Change;
        if (change && typeof change.kind === "string") emit(change);
      } catch {
        // Not a change: ignored.
      }
    });
    source.onopen = () => {
      setStatus("live");
      if (opened) emit({ kind: "resync" });
      opened = true;
    };
    source.onerror = () => {
      if (source && source.readyState !== EventSource.CLOSED) return setStatus("connecting");
      setStatus("offline");
      source?.close();
      retry = window.setTimeout(open, 5000);
    };
  };
  open();
  return () => {
    stopped = true;
    window.clearTimeout(retry);
    source?.close();
  };
}

/** Calls `handler` with every change (and every resync); the latest handler is always the one called. */
export function useChanges(handler: (change: Change) => void): void {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    const listener = (change: Change) => ref.current(change);
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, []);
}

export function useStreamStatus(): StreamStatus {
  return useSyncExternalStore(
    (onChange) => {
      statusListeners.add(onChange);
      return () => void statusListeners.delete(onChange);
    },
    () => status,
  );
}
