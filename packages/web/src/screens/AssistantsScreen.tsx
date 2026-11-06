import { useState } from "react";
import { api, describeError } from "../api.ts";
import { useResource } from "../hooks.ts";
import { amount } from "../signable.ts";
import type { AddedAgent, Info } from "../types.ts";
import { snippets } from "./snippets.ts";

/**
 * The assistants you let shop. Each gets its own token for PureStrings' MCP server, so every payment it asks for
 * carries its name on your key and in the ledger, and it sees only its own. Take a token back and it can't ask again.
 */
export function AssistantsScreen({ info }: { readonly info: Info | null }) {
  const agents = useResource(() => api.agents(), ["agents"]);
  const payments = useResource(() => api.signs("buy"), ["sign"]);
  const [name, setName] = useState("OpenClaw");
  const [added, setAdded] = useState<AddedAgent | null>(null);
  const [error, setError] = useState<string | null>(null);

  const spentBy = (agent: string) => (payments.data ?? []).filter((one) => one.agent === agent && one.status === "paid").reduce((sum, one) => sum + (one.signed?.kind === "buy" ? Number(one.signed.total) : 0), 0);
  const askedBy = (agent: string) => (payments.data ?? []).filter((one) => one.agent === agent).length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Assistants</h1>
          <p>Any assistant that speaks MCP can shop through PureStrings: OpenClaw, Hermes Agent, Claude Code, Cursor. They can ask to buy. Only your key pays.</p>
        </div>
      </div>

      <div className="grid">
        <div className="card stack">
          <h2>Connect an assistant</h2>
          <form
            className="row"
            style={{ flexWrap: "nowrap" }}
            onSubmit={(event) => {
              event.preventDefault();
              setError(null);
              void api.addAgent(name.trim()).then(
                (made) => {
                  setAdded(made);
                  void agents.reload();
                },
                (caught: unknown) => setError(describeError(caught)),
              );
            }}
          >
            <input className="input" value={name} onChange={(event) => setName(event.target.value)} aria-label="The assistant's name" placeholder="Its name, as your key will say it" />
            <button type="submit" className="btn primary" disabled={!name.trim()}>
              Make a token
            </button>
          </form>
          <p className="muted small">The name goes into every payment it asks for, so your key says "{name.trim() || "OpenClaw"} asks to pay…".</p>
          {error ? <div className="error">{error}</div> : null}
          {added ? <Setup added={added} /> : null}
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Connected</h2>
            <span className="muted small mono">{info?.mcp}</span>
          </div>
          <ul className="list">
            {(agents.data ?? []).map((agent) => (
              <li key={agent.id}>
                <span className="agent" style={{ flex: 1 }}>
                  <i>{agent.name.slice(0, 1).toUpperCase()}</i>
                  <span>
                    {agent.name}
                    <div className="muted small" style={{ fontWeight: 450 }}>
                      {askedBy(agent.name)} asked · {amount(spentBy(agent.name).toFixed(2), "USD")} paid · {agent.lastSeenAt ? `last seen ${new Date(agent.lastSeenAt).toLocaleString()}` : "not seen yet"}
                    </div>
                  </span>
                </span>
                <button type="button" className="btn quiet danger" onClick={() => void api.removeAgent(agent.id).then(agents.reload)}>
                  Take back
                </button>
              </li>
            ))}
          </ul>
          {agents.data?.length === 0 ? <div className="empty">No assistants yet.</div> : null}
        </div>
      </div>
    </div>
  );
}

/** How to connect the assistant just made: its token, shown this once, in each assistant's own words. */
function Setup({ added }: { readonly added: AddedAgent }) {
  const all = snippets(added.mcp.url, added.token);
  const [which, setWhich] = useState(all[0]!.name);
  const shown = all.find((one) => one.name === which) ?? all[0]!;
  return (
    <div className="stack">
      <div className="note">{added.agent.name}'s token is shown this once. Copy it now.</div>
      <div className="tabs" role="group" aria-label="Assistant">
        {all.map((one) => (
          <button key={one.name} type="button" aria-pressed={which === one.name} onClick={() => setWhich(one.name)}>
            {one.name}
          </button>
        ))}
      </div>
      <p className="small muted">{shown.where}</p>
      <code className="code">{shown.text}</code>
      <button type="button" className="btn" onClick={() => void navigator.clipboard?.writeText(shown.text)}>
        Copy
      </button>
    </div>
  );
}
