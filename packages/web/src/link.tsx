import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { keySocketUrl } from "./api.ts";
import { type BrowserKey, loadKey } from "./key.ts";
import { readSignable } from "./signable.ts";
import { spokenSignable } from "./spoken.ts";

/**
 * The key in this browser, connected to PureStrings the way the button is (/keys/ws): it's shown what waits for
 * its signature, reads it here, says it aloud when you want, signs only on a full hold, and hears how it went.
 * It stays connected on every screen, so a payment an assistant asks for finds you wherever you are.
 */

export type KeyScreen =
  | { readonly type: "sign"; readonly id: string; readonly kind: "buy" | "link" | "allow"; readonly flow: string; readonly text: string; readonly line: string; readonly expires: string; readonly more: number }
  | { readonly type: "idle"; readonly spentTodayUsd: number };

export interface Outcome {
  readonly id: string;
  readonly status: "paid" | "linking" | "set" | "failed" | "declined";
  readonly line: string;
}

export interface KeyLink {
  readonly key: BrowserKey | null;
  readonly connected: boolean;
  /** Whether PureStrings holds this key, and its fingerprint there. */
  readonly signer: { readonly ok: boolean; readonly fingerprint: string; readonly problem?: string } | null;
  readonly screen: KeyScreen | null;
  readonly outcome: Outcome | null;
  readonly error: string | null;
  /** Signs exactly the text on the screen (once it's read here); nothing else. */
  readonly sign: () => Promise<void>;
  readonly decline: () => void;
  readonly voice: boolean;
  readonly setVoice: (on: boolean) => void;
  /** Like the button without a screen: nothing shown, everything said. */
  readonly noScreen: boolean;
  readonly setNoScreen: (on: boolean) => void;
  /** Whether this key has signed for a shop before: one it hasn't gets a warning. */
  readonly knows: (shopId: string) => boolean;
  readonly say: (text: string) => void;
}

const Context = createContext<KeyLink | null>(null);

const SHOPS = "purestrings.key-shops";
const VOICE = "purestrings.voice";
const NO_SCREEN = "purestrings.no-screen";

function remembered(name: string): string | null {
  try {
    return localStorage.getItem(name);
  } catch {
    return null;
  }
}

function remember(name: string, value: string): void {
  try {
    localStorage.setItem(name, value);
  } catch {
    // Not kept, then: it lasts for this visit.
  }
}

function speak(text: string): void {
  if (typeof speechSynthesis === "undefined" || !text) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1;
  speechSynthesis.speak(utterance);
}

export function KeyLinkProvider({ children }: { readonly children: ReactNode }) {
  const [key, setKey] = useState<BrowserKey | null>(null);
  const [connected, setConnected] = useState(false);
  const [signer, setSigner] = useState<KeyLink["signer"]>(null);
  const [screen, setScreen] = useState<KeyScreen | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [voice, setVoiceState] = useState(remembered(VOICE) === "on");
  const [noScreen, setNoScreenState] = useState(remembered(NO_SCREEN) === "on");
  const [shops, setShops] = useState<readonly string[]>(() => {
    try {
      return JSON.parse(remembered(SHOPS) ?? "[]") as string[];
    } catch {
      return [];
    }
  });
  const socket = useRef<WebSocket | null>(null);
  const spoken = useRef<string | null>(null);
  const speaking = voice || noScreen;
  const speakingRef = useRef(speaking);
  const shopsRef = useRef(shops);
  const screenRef = useRef(screen);
  useEffect(() => {
    speakingRef.current = speaking;
    shopsRef.current = shops;
    screenRef.current = screen;
  });

  useEffect(() => {
    void loadKey().then(setKey);
  }, []);

  useEffect(() => {
    if (!key) return;
    let stopped = false;
    let retry: number | undefined;
    const open = () => {
      const ws = new WebSocket(keySocketUrl());
      socket.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!stopped) retry = window.setTimeout(open, 3000);
      };
      ws.onmessage = (event: MessageEvent<string>) => {
        let message: Record<string, any>;
        try {
          message = JSON.parse(event.data) as Record<string, any>;
        } catch {
          return;
        }
        switch (message.type) {
          case "hello":
            return ws.send(JSON.stringify({ type: "hello", key: key.key }));
          case "signer":
            return setSigner({ ok: Boolean(message.ok), fingerprint: String(message.fingerprint), ...(message.problem ? { problem: String(message.problem) } : {}) });
          case "sign": {
            const shown = message as KeyScreen & { type: "sign" };
            setScreen(shown);
            setError(null);
            if (spoken.current !== shown.id && speakingRef.current) {
              const read = readSignable(shown.text);
              speak(spokenSignable(shown.text, read ? !shopsRef.current.includes(read.shop.id) : false));
            }
            spoken.current = shown.id;
            return;
          }
          case "idle":
            spoken.current = null;
            return setScreen({ type: "idle", spentTodayUsd: Number(message.spentTodayUsd ?? 0) });
          case "signed": {
            const read = screenRef.current?.type === "sign" ? readSignable(screenRef.current.text) : null;
            if (read && !shopsRef.current.includes(read.shop.id)) {
              const next = [...shopsRef.current, read.shop.id];
              setShops(next);
              remember(SHOPS, JSON.stringify(next));
            }
            return;
          }
          case "answered":
            return setOutcome({ id: String(message.id), status: "declined", line: "Refused. Nothing was paid." });
          case "payment":
            setOutcome({ id: String(message.id), status: message.status, line: String(message.line) });
            if (speakingRef.current) speak(String(message.line));
            return;
          case "error":
            return setError(String(message.message));
        }
      };
    };
    open();
    return () => {
      stopped = true;
      window.clearTimeout(retry);
      socket.current?.close();
    };
  }, [key]);

  const sign = useCallback(async () => {
    const shown = screenRef.current;
    if (!key || shown?.type !== "sign") return;
    // Read here, from the text itself: what can't be read in full isn't signed.
    if (!readSignable(shown.text)) return setError("This key can't read what it's asked to sign, so it won't sign it.");
    const signature = await key.sign(shown.text);
    socket.current?.send(JSON.stringify({ type: "sign", id: shown.id, signature }));
  }, [key]);

  const decline = useCallback(() => {
    const shown = screenRef.current;
    if (shown?.type === "sign") socket.current?.send(JSON.stringify({ type: "decline", id: shown.id }));
  }, []);

  const value: KeyLink = {
    key,
    connected,
    signer,
    screen,
    outcome,
    error,
    sign,
    decline,
    voice: speaking,
    setVoice: (on) => {
      setVoiceState(on);
      remember(VOICE, on ? "on" : "off");
      if (!on) speechSynthesis?.cancel();
    },
    noScreen,
    setNoScreen: (on) => {
      setNoScreenState(on);
      remember(NO_SCREEN, on ? "on" : "off");
      const shown = screenRef.current;
      if (on && shown?.type === "sign") {
        const read = readSignable(shown.text);
        speak(spokenSignable(shown.text, read ? !shopsRef.current.includes(read.shop.id) : false));
      }
    },
    knows: (shopId) => shops.includes(shopId),
    say: speak,
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useKeyLink(): KeyLink {
  const link = useContext(Context);
  if (!link) throw new Error("useKeyLink needs a KeyLinkProvider.");
  return link;
}
