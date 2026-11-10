import { useSyncExternalStore } from "react";

/** Hash routes, so the built app works from any path: #/ (the purse), #/ledger, #/key, #/assistants, #/shop. */

export type Screen = "purse" | "ledger" | "key" | "assistants" | "shop";
export const SCREENS: readonly Screen[] = ["purse", "ledger", "key", "assistants", "shop"];

export function screenOf(hash: string): Screen {
  const name = hash.replace(/^#\/?/, "").split(/[/?]/)[0] ?? "";
  // Coming back from PayPal after linking: #/keys.
  if (name === "keys") return "key";
  return (SCREENS as readonly string[]).includes(name) ? (name as Screen) : "purse";
}

export const hrefOf = (screen: Screen): string => (screen === "purse" ? "#/" : `#/${screen}`);

const subscribe = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};

export function useScreen(): Screen {
  return screenOf(useSyncExternalStore(subscribe, () => window.location.hash));
}

/** #/welcome: what PureStrings is, the page anyone without its token sees. */
export function useWelcome(): boolean {
  return /^#\/?welcome/.test(useSyncExternalStore(subscribe, () => window.location.hash));
}
