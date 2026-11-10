import { lazy, type ReactNode, Suspense, useEffect, useState } from "react";
import { api, ApiError, describeError, readToken } from "./api.ts";
import { startEvents, useStreamStatus } from "./events.ts";
import { useResource } from "./hooks.ts";
import { KeyLinkProvider, useKeyLink } from "./link.tsx";
import { icons, Logo } from "./parts/icons.tsx";
import { hrefOf, type Screen, SCREENS, useScreen, useWelcome } from "./router.ts";
import { AssistantsScreen } from "./screens/AssistantsScreen.tsx";
import { KeyScreen } from "./screens/KeyScreen.tsx";
import { Landing } from "./screens/Landing.tsx";
import { PurseScreen } from "./screens/PurseScreen.tsx";
import { ShopScreen } from "./screens/ShopScreen.tsx";
import type { Info } from "./types.ts";
import { startWebMcp } from "./webmcp.ts";

// The ledger carries AG Grid: it loads when it's first opened.
const LedgerScreen = lazy(async () => ({ default: (await import("./screens/LedgerScreen.tsx")).LedgerScreen }));

const NAMES: Readonly<Record<Screen, string>> = { purse: "Purse", ledger: "Ledger", key: "Key", assistants: "Assistants", shop: "Shop" };

/**
 * PureStrings: what it is, for anyone without its token (and at #/welcome), then the five screens with your key
 * connected throughout.
 */
export function App() {
  const [info, setInfo] = useState<Info | null>(null);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState(0);
  const welcome = useWelcome();

  useEffect(() => {
    void (async () => {
      try {
        const got = await api.info();
        setInfo(got);
        if (!got.token) return setLocked(false);
        if (!readToken()) return setLocked(true);
        await api.agents();
        setLocked(false);
      } catch (caught) {
        if (caught instanceof ApiError && caught.status === 401) return setLocked(true);
        setError(describeError(caught));
      }
    })();
  }, [opened]);

  if (locked || welcome) return <Landing info={info} locked={locked} onOpen={() => setOpened((count) => count + 1)} />;
  if (!info) return <div className="main">{error ? <div className="error">PureStrings isn't answering: {error}</div> : <span className="muted">Opening PureStrings…</span>}</div>;
  return (
    <KeyLinkProvider>
      <Frame info={info} />
    </KeyLinkProvider>
  );
}

function Frame({ info }: { readonly info: Info }) {
  const screen = useScreen();
  const stream = useStreamStatus();
  const link = useKeyLink();
  const waiting = useResource(() => api.signs(), ["sign"]);
  const count = (waiting.data ?? []).filter((one) => one.status === "waiting").length;
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => startEvents(), []);
  useEffect(() => startWebMcp(), []);
  useEffect(() => {
    if (!link.outcome) return;
    setToast(link.outcome.line);
    const timer = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(timer);
  }, [link.outcome]);
  useEffect(() => {
    document.title = count ? `(${count}) PureStrings` : "PureStrings";
  }, [count]);

  const pages: Readonly<Record<Screen, ReactNode>> = {
    purse: <PurseScreen info={info} />,
    ledger: (
      <Suspense fallback={<span className="muted">Opening the ledger…</span>}>
        <LedgerScreen info={info} />
      </Suspense>
    ),
    key: <KeyScreen />,
    assistants: <AssistantsScreen info={info} />,
    shop: <ShopScreen info={info} />,
  };
  return (
    <div className="app">
      <nav className="rail" aria-label="PureStrings">
        <a className="brand" href={hrefOf("purse")}>
          <Logo />
          <span>
            <b>PureStrings</b>
            <small>only your key can pay</small>
          </span>
        </a>
        {SCREENS.map((one) => (
          <a key={one} className="nav" href={hrefOf(one)} aria-current={screen === one ? "page" : undefined}>
            {icons[one]}
            {NAMES[one]}
            {(one === "purse" || one === "key") && count ? <span className="count">{count}</span> : null}
          </a>
        ))}
        <div className="rail-foot">
          <span className={`pill ${stream === "live" ? "good" : stream === "offline" ? "bad" : ""}`}>{stream === "live" ? "Live" : stream === "offline" ? "Offline" : "Connecting"}</span>
          <span className={`pill ${link.connected && link.signer?.ok ? "good" : "wait"}`}>{link.connected && link.signer?.ok ? "Key connected" : "Key not connected"}</span>
          {info.paypal ? <span className="pill info">PayPal {info.paypal}</span> : <span className="pill">No PayPal</span>}
          {info.model ? <span className="pill plain" title="The model that writes allowances and disputes">{info.model}</span> : null}
          <a className="muted small" href="#/welcome">
            What PureStrings is
          </a>
        </div>
      </nav>
      <main className="main">{pages[screen]}</main>
      {toast ? (
        <div className="toast" role="status">
          {toast}
        </div>
      ) : null}
    </div>
  );
}
