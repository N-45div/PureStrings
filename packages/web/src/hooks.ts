import { useCallback, useEffect, useRef, useState } from "react";
import { describeError } from "./api.ts";
import { type Change, useChanges } from "./events.ts";

export interface Resource<T> {
  readonly data: T | null;
  readonly error: string | null;
  readonly reload: () => Promise<void>;
}

/**
 * Loads something from PureStrings, and again whenever a change of one of `kinds` comes in (or the stream
 * comes back). The last good data stays while a reload fails.
 */
export function useResource<T>(load: () => Promise<T>, kinds: readonly Change["kind"][] = []): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  const sequence = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    loadRef.current = load;
  });
  const reload = useCallback(async () => {
    const mine = ++sequence.current;
    try {
      const result = await loadRef.current();
      if (mine !== sequence.current) return;
      setData(result);
      setError(null);
    } catch (caught) {
      if (mine === sequence.current) setError(describeError(caught));
    }
  }, []);
  useEffect(() => {
    void reload();
    return () => window.clearTimeout(timer.current);
  }, [reload]);
  useChanges((change) => {
    if (change.kind !== "resync" && !kinds.includes(change.kind)) return;
    // A burst of changes (a payment signed, then paid) is one reload.
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void reload(), 120);
  });
  return { data, error, reload };
}

/** Now, every `ms`: for countdowns. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(tick);
  }, [ms]);
  return now;
}
