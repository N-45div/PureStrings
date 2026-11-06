import type { SignStatus, Verdict } from "../types.ts";

/** How a payment, link or allowance stands, in a word and a colour. */
const STATUS: Readonly<Record<SignStatus, readonly [string, string]>> = {
  waiting: ["waiting for your key", "wait"],
  signed: ["signed", "info"],
  paid: ["paid", "good"],
  linked: ["linked", "good"],
  active: ["active", "good"],
  stopped: ["stopped", ""],
  declined: ["refused", ""],
  expired: ["expired", ""],
  failed: ["failed", "bad"],
};

export function StatusPill({ status }: { readonly status: SignStatus }) {
  const [word, tone] = STATUS[status] ?? [status, ""];
  return <span className={`pill ${tone}`}>{word}</span>;
}

/** What the auditor made of a PayPal charge. */
const VERDICT: Readonly<Record<Verdict, readonly [string, string]>> = {
  signed: ["signed by your key", "good"],
  allowed: ["under an allowance", "good"],
  unsigned: ["nobody signed", "bad"],
  mismatch: ["not what was signed", "bad"],
};

export function VerdictPill({ verdict, flagged }: { readonly verdict: Verdict; readonly flagged: boolean }) {
  const [word, tone] = VERDICT[verdict];
  return <span className={`pill ${flagged ? tone : verdict === "unsigned" || verdict === "mismatch" ? "" : tone}`}>{flagged ? word : verdict === "unsigned" || verdict === "mismatch" ? "money back" : word}</span>;
}
