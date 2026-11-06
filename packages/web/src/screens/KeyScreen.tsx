import { useEffect, useState } from "react";
import { api, describeError } from "../api.ts";
import { useResource } from "../hooks.ts";
import { useKeyLink } from "../link.tsx";
import { Hold } from "../parts/Hold.tsx";
import { Receipt } from "../parts/Receipt.tsx";
import { amount, readSignable } from "../signable.ts";

/**
 * Your keys. The one in this browser, drawn as the button is: a small screen that shows exactly what it signs, and
 * one button you hold for two seconds. It can say each payment aloud, or work with no screen at all, as the button
 * without one does. Below: the buttons you've added, and linking a key to your PayPal at a shop.
 */
export function KeyScreen() {
  const link = useKeyLink();
  const shown = link.screen;
  const read = shown?.type === "sign" ? readSignable(shown.text) : null;
  const fresh = read ? !link.knows(read.shop.id) && read.kind !== "link" : false;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Your key</h1>
          <p>Only a key of yours can pay. It reads what it signs from the text itself, and signs only when you hold its button for two seconds.</p>
        </div>
        <div className="row">
          <label className="switch">
            <input type="checkbox" checked={link.voice} disabled={link.noScreen} onChange={(event) => link.setVoice(event.target.checked)} /> Say it aloud
          </label>
          <label className="switch">
            <input type="checkbox" checked={link.noScreen} onChange={(event) => link.setNoScreen(event.target.checked)} /> No screen
          </label>
        </div>
      </div>

      <div className="grid">
        <div className="stack">
          <div className="device">
            {link.noScreen ? (
              <div className="device-screen dark">
                <div>
                  <div style={{ fontSize: 28 }}>◉ ◉ ◉</div>
                  <div>No screen: listen, then hold.</div>
                  {shown?.type === "sign" ? (
                    <button type="button" className="btn quiet" style={{ color: "#9fc5ab" }} onClick={() => shown && link.setNoScreen(true)}>
                      Say it again
                    </button>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="device-screen">
                {!link.connected ? (
                  <div className="dim">Connecting to PureStrings…</div>
                ) : shown?.type === "sign" && read ? (
                  <KeyText shown={shown} fresh={fresh} />
                ) : shown?.type === "sign" ? (
                  <div>Can't read this one, so it won't be signed. Tap to refuse.</div>
                ) : (
                  <div className="stack" style={{ gap: 6 }}>
                    <div className="dim">Nothing to sign.</div>
                    <div className="big">${(shown?.type === "idle" ? shown.spentTodayUsd : 0).toFixed(2)}</div>
                    <div className="dim">paid today</div>
                  </div>
                )}
              </div>
            )}
            <Hold disabled={shown?.type !== "sign" || !link.signer?.ok || !read} onSign={() => void link.sign()} onRefuse={link.decline} label={shown?.type === "sign" ? "HOLD" : "·"} />
            <div className="device-foot">
              <span>{link.signer ? `key ${link.signer.fingerprint}` : "key …"}</span>
              {shown?.type === "sign" ? (
                <button type="button" onClick={link.decline}>
                  Refuse
                </button>
              ) : (
                <span>{link.connected ? "● online" : "○ offline"}</span>
              )}
            </div>
          </div>
          {link.error ? <div className="error">{link.error}</div> : null}
          {link.signer && !link.signer.ok ? <div className="error">{link.signer.problem}</div> : null}
          {link.key && !link.key.kept ? <div className="note">This browser can't keep a key (a private window?), so this one lasts until the page closes.</div> : null}
        </div>

        <div className="stack">
          {shown?.type === "sign" ? (
            <div className="card">
              <div className="card-head">
                <h2>What it signs</h2>
                {shown.more ? <span className="pill wait">{shown.more} more waiting</span> : null}
              </div>
              <Receipt text={shown.text} fresh={fresh} />
            </div>
          ) : null}
          <Buttons />
          <Linking />
        </div>
      </div>
    </div>
  );
}

/** The key's own small screen: the shop, each line, the total, from the text. */
function KeyText({ shown, fresh }: { readonly shown: { readonly text: string; readonly flow: string }; readonly fresh: boolean }) {
  const read = readSignable(shown.text)!;
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="dim">{shown.flow}</div>
      {fresh ? <div style={{ color: "#ffb38a" }}>! NEW SHOP</div> : null}
      <div style={{ fontWeight: 700 }}>{read.shop.name}</div>
      {read.kind === "buy" ? (
        <>
          {read.items.slice(0, 4).map((item, index) => (
            <div key={index} className="spread">
              <span>
                {item.qty}× {item.name.slice(0, 22)}
              </span>
            </div>
          ))}
          {read.items.length > 4 ? <div className="dim">+{read.items.length - 4} more</div> : null}
          <div className="big">{amount(read.total, read.currency)}</div>
        </>
      ) : read.kind === "link" ? (
        <div>Link your PayPal here to this key.</div>
      ) : (
        <>
          <div>Allowance: {read.for}</div>
          <div>
            {amount(read.each, read.currency)} a time · {amount(read.total, read.currency)} a {read.per}
          </div>
        </>
      )}
      <div className="dim">hold to sign · tap to refuse</div>
    </div>
  );
}

/** The PureStrings buttons you've added: each gets its own token, shown once. */
function Buttons() {
  const devices = useResource(() => api.devices(), ["keys"]);
  const [added, setAdded] = useState<{ token: string; ws: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Buttons</h2>
          <p>A PureStrings button signs with a key made in its own chip, which never leaves it.</p>
        </div>
        <button
          type="button"
          className="btn"
          onClick={() =>
            void api.addDevice("PureStrings button").then(
              (made) => setAdded({ token: made.token, ws: made.ws }),
              (caught: unknown) => setError(describeError(caught)),
            )
          }
        >
          Add a button
        </button>
      </div>
      {added ? (
        <div className="stack">
          <div className="note">Put these in the button's config.h. The token is shown this once.</div>
          <code className="code">{`#define PURESTRINGS_URL "${added.ws}"\n#define PURESTRINGS_TOKEN "${added.token}"`}</code>
        </div>
      ) : null}
      {error ? <div className="error">{error}</div> : null}
      <ul className="list">
        {(devices.data ?? []).map((device) => (
          <li key={device.id}>
            <div style={{ flex: 1 }}>
              <b>{device.name}</b>
              <div className="muted small mono">{device.signer ? `key ${device.signer.fingerprint}` : "hasn't connected yet"}</div>
            </div>
            <button type="button" className="btn quiet danger" onClick={() => void api.removeDevice(device.id).then(devices.reload)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      {devices.data?.length === 0 && !added ? <div className="empty">No buttons yet. The key in this browser works on its own.</div> : null}
    </div>
  );
}

/** Linking a key to your PayPal at a shop: the shop writes what the key signs, then PayPal's own page saves your PayPal there. */
function Linking() {
  const link = useKeyLink();
  const links = useResource(() => api.signs("link"), ["sign"]);
  const [error, setError] = useState<string | null>(null);
  const newest = links.data?.[0];
  const approve = newest && newest.status === "signed" ? (newest.result as { approveUrl?: string } | null)?.approveUrl : undefined;
  const linked = links.data?.find((one) => one.status === "linked" && one.key === link.key?.key);
  // Back from PayPal (or later): ask the shop how each signed link went.
  const open = links.data?.filter((one) => one.status === "signed").map((one) => one.id).join(",") ?? "";
  useEffect(() => {
    if (!open) return;
    void Promise.all(open.split(",").map((id) => api.checkLink(id).catch(() => null))).then(() => links.reload());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Your PayPal at Bean & Leaf</h2>
          <p>Link once: your key signs to say it pays for your carts there, then you say yes on PayPal's own page.</p>
        </div>
        {linked ? <span className="pill good">Linked</span> : null}
      </div>
      <div className="row">
        <button
          type="button"
          className="btn primary"
          disabled={!link.key || !link.signer?.ok}
          onClick={() => {
            setError(null);
            void api.link(link.key!.key).then(links.reload, (caught: unknown) => setError(describeError(caught)));
          }}
        >
          {linked ? "Link again" : "Link this key"}
        </button>
        {approve ? (
          <a className="btn brass" href={approve}>
            Say yes on PayPal →
          </a>
        ) : null}
        {newest?.status === "signed" && !approve ? <span className="muted small">Waiting for the shop…</span> : null}
        {newest?.status === "waiting" ? <span className="pill wait">Hold your key to sign the link</span> : null}
      </div>
      {newest?.status === "failed" ? <div className="error" style={{ marginTop: 10 }}>{newest.error}</div> : null}
      {error ? <div className="error" style={{ marginTop: 10 }}>{error}</div> : null}
    </div>
  );
}
