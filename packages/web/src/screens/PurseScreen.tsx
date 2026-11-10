import { useState } from "react";
import { api, describeError } from "../api.ts";
import { useResource } from "../hooks.ts";
import { useKeyLink } from "../link.tsx";
import { Hold } from "../parts/Hold.tsx";
import { Receipt } from "../parts/Receipt.tsx";
import { StatusPill } from "../parts/Status.tsx";
import { hrefOf } from "../router.ts";
import { amount, readSignable } from "../signable.ts";
import type { Info, SignView } from "../types.ts";

/**
 * The purse: what's waiting for your key right now, what was paid, the allowances that let small things through
 * without asking, and what the auditor found in PayPal's own record.
 */
export function PurseScreen({ info }: { readonly info: Info | null }) {
  const signs = useResource(() => api.signs("buy"), ["sign"]);
  const payments = signs.data ?? [];
  const waiting = payments.filter((one) => one.status === "waiting");
  const paid = payments.filter((one) => one.status === "paid");
  const since = (days: number) => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - days);
    return paid.filter((one) => (one.signedAt ?? one.createdAt) >= start.toISOString()).reduce((sum, one) => sum + (one.signed?.kind === "buy" ? Number(one.signed.total) : 0), 0);
  };
  const agents = new Set(paid.map((one) => one.agent).filter(Boolean));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Your purse</h1>
          <p>Your assistants shop; your key pays. Everything they ask for comes here first, with who asked and exactly what it costs.</p>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ gap: 40 }}>
          <div className="stat">
            <b>${since(0).toFixed(2)}</b>
            <span>paid today</span>
          </div>
          <div className="stat">
            <b>${since(6).toFixed(2)}</b>
            <span>this week</span>
          </div>
          <div className="stat">
            <b>{waiting.length}</b>
            <span>waiting for your key</span>
          </div>
          <div className="stat">
            <b>{agents.size}</b>
            <span>{agents.size === 1 ? "assistant has" : "assistants have"} bought</span>
          </div>
        </div>
      </div>

      {waiting.length ? (
        <div className="grid">
          {waiting.map((payment) => (
            <Waiting key={payment.id} payment={payment} />
          ))}
        </div>
      ) : null}

      <div className="grid">
        <Allowances info={info} />
        <Auditor info={info} />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Lately</h2>
          <a href={hrefOf("ledger")}>The whole ledger →</a>
        </div>
        {payments.length ? (
          <ul className="list">
            {payments.slice(0, 6).map((payment) => (
              <li key={payment.id}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{payment.line}</div>
                  <div className="muted small">{new Date(payment.createdAt).toLocaleString()}</div>
                </div>
                <StatusPill status={payment.status} />
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty">Nothing yet. Connect an assistant in Assistants, or try the Shop yourself.</div>
        )}
      </div>
    </div>
  );
}

/** A payment waiting for your key: the receipt, and the key's button right here when it's this one on the key. */
function Waiting({ payment }: { readonly payment: SignView }) {
  const link = useKeyLink();
  const read = readSignable(payment.text);
  const onKey = link.screen?.type === "sign" && link.screen.id === payment.id;
  return (
    <div className="card">
      <div className="card-head">
        <h2>Waiting for your key</h2>
        <span className="pill wait">waiting</span>
      </div>
      <Receipt text={payment.text} fresh={read ? !link.knows(read.shop.id) : false} />
      <div className="spread" style={{ marginTop: 16 }}>
        <div className="stack" style={{ gap: 6 }}>
          <span className="muted small">{onKey ? "Hold for two seconds to pay. Tap to refuse." : "Next on your key."}</span>
          <div className="row">
            <a className="btn" href={hrefOf("key")}>
              Open your key
            </a>
            <button type="button" className="btn danger" onClick={() => void api.decline(payment.id)}>
              Refuse
            </button>
          </div>
        </div>
        {onKey ? <Hold onSign={() => void link.sign()} onRefuse={link.decline} disabled={!link.signer?.ok} /> : null}
      </div>
    </div>
  );
}

/** Allowances: your key says once that small things at a shop go through without asking, within limits the shop holds. */
function Allowances({ info }: { readonly info: Info | null }) {
  const link = useKeyLink();
  const allowances = useResource(() => api.allowances(), ["sign"]);
  const agents = useResource(() => api.agents(), ["agents"]);
  const [said, setSaid] = useState("Coffee and tea, up to $15 a time and $40 a week");
  const [by, setBy] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = (allowances.data ?? []).filter((one) => one.status === "active" || one.status === "waiting");
  const ask = async () => {
    setBusy(true);
    setError(null);
    try {
      // Signed by the key in this browser: with a button too, PureStrings would otherwise ask which.
      await api.allow({ ...(info?.model ? { said } : { for: "Coffee", each: "15", total: "40", per: "week", days: 30 }), ...(by ? { by } : {}) }, link.key?.key);
      await allowances.reload();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Allowances</h2>
          <p>Small buys that fit one go through on their own. Anything more comes to your key.</p>
        </div>
      </div>
      <div className="stack">
        {shown.map((allowance) => {
          const signed = allowance.signed?.kind === "allow" ? allowance.signed : null;
          const use = /([\d.]+) of \D*([\d.]+)/.exec(allowance.use ?? "");
          const part = use ? Math.min(1, Number(use[1]) / Number(use[2])) : 0;
          return (
            <div key={allowance.id} className="stack" style={{ gap: 6 }}>
              <div className="spread">
                <b>
                  {signed?.for} at {signed?.shop.name}
                  {signed?.by ? <span className="pill info" style={{ marginLeft: 8 }}>{signed.by} only</span> : null}
                </b>
                {allowance.status === "waiting" ? (
                  <span className="pill wait">sign it on your key</span>
                ) : (
                  <button type="button" className="btn quiet danger" onClick={() => void api.stopAllowance(allowance.id).then(allowances.reload)}>
                    Stop
                  </button>
                )}
              </div>
              {signed ? (
                <div className="muted small">
                  up to {amount(signed.each, signed.currency)} a time, {amount(signed.total, signed.currency)} a {signed.per}, until {signed.expires.slice(0, 10)}
                </div>
              ) : null}
              {allowance.status === "active" ? (
                <>
                  <div className="meter">
                    <span style={{ width: `${part * 100}%` }} />
                  </div>
                  <div className="muted small">{allowance.use}</div>
                </>
              ) : null}
            </div>
          );
        })}
        {!shown.length ? <div className="empty">No allowances: every payment asks your key.</div> : null}
        <div className="field">
          {info?.model ? `Say it, and ${info.model} writes the limits; your key shows them before you sign` : "A new allowance (set MODEL_URL, MODEL and MODEL_KEY, or NEBIUS_API_KEY, to say it in words)"}
          <div className="row" style={{ flexWrap: "nowrap" }}>
            {info?.model ? <input className="input" value={said} onChange={(event) => setSaid(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void ask()} /> : null}
            {agents.data?.length ? (
              <select className="input" style={{ width: "auto" }} value={by} onChange={(event) => setBy(event.target.value)} aria-label="Which assistant it's for">
                <option value="">any assistant</option>
                {agents.data.map((agent) => (
                  <option key={agent.id} value={agent.name}>
                    {agent.name} only
                  </option>
                ))}
              </select>
            ) : null}
            <button type="button" className="btn primary" disabled={busy} onClick={() => void ask()}>
              {busy ? "Writing…" : info?.model ? "Ask" : "$15 a time, $40 a week"}
            </button>
          </div>
        </div>
        {error ? <div className="error">{error}</div> : null}
      </div>
    </div>
  );
}

/** The auditor: PayPal's own record of every charge, checked against what your keys signed. */
function Auditor({ info }: { readonly info: Info | null }) {
  const audit = useResource(() => (info?.auditor ? api.audit() : Promise.resolve(null)), ["audit"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flagged = audit.data?.findings.filter((finding) => finding.flagged) ?? [];
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Auditor</h2>
          <p>Every charge PayPal made should be one your key signed. Any other is flagged, with a dispute drafted.</p>
        </div>
        {info?.auditor ? (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              void api
                .runAudit()
                .then(audit.reload, (caught: unknown) => setError(describeError(caught)))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Checking…" : "Check now"}
          </button>
        ) : null}
      </div>
      {!info?.auditor ? <div className="empty">The auditor reads PayPal's record: set PayPal's keys to turn it on.</div> : null}
      {audit.data ? (
        <div className="stack">
          <div className="row">
            <span className={`pill ${flagged.length ? "bad" : audit.data.findings.length ? "good" : ""}`}>{flagged.length ? `${flagged.length} flagged` : audit.data.findings.length ? "all signed" : "no charges yet"}</span>
            <span className="muted small">
              {audit.data.findings.length} charges checked{audit.data.checkedAt ? `, ${new Date(audit.data.checkedAt).toLocaleTimeString()}` : ""}
            </span>
          </div>
          {flagged.slice(0, 3).map((finding) => (
            <div key={finding.charge.captureId} className="stack" style={{ gap: 6, padding: 12, borderRadius: 12, background: "var(--rust-soft)" }}>
              <div className="spread">
                <b>{amount(finding.charge.amount, finding.charge.currency || "USD")} nobody signed</b>
                <span className="mono small">{finding.charge.captureId}</span>
              </div>
              <div className="small">{finding.why}</div>
              {finding.draft ? (
                <details>
                  <summary className="small" style={{ cursor: "pointer", fontWeight: 650 }}>
                    The dispute, ready to send PayPal
                  </summary>
                  <p className="small" style={{ marginTop: 6 }}>
                    {finding.draft}
                  </p>
                  <button type="button" className="btn quiet" onClick={() => void navigator.clipboard?.writeText(finding.draft ?? "")}>
                    Copy
                  </button>
                </details>
              ) : null}
            </div>
          ))}
          {audit.data.note ? <div className="note">{audit.data.note}</div> : null}
        </div>
      ) : null}
      {error ?? audit.error ? <div className="error">{error ?? audit.error}</div> : null}
    </div>
  );
}
