import { useNow } from "../hooks.ts";
import { amount, readSignable } from "../signable.ts";

/**
 * Exactly what a key signs, as a receipt: read here from the text itself, never from words sent beside it. Who
 * asked, the shop (with a warning when your key hasn't signed for it before), each line, the total, and how long
 * the signature is good for.
 */
export function Receipt({ text, fresh = false, compact = false }: { readonly text: string; readonly fresh?: boolean; readonly compact?: boolean }) {
  const now = useNow();
  const read = readSignable(text);
  if (!read) return <div className="error">This can't be read in full, so no key of yours will sign it.</div>;
  const left = Math.max(0, Math.round((Date.parse(read.expires) - now) / 1000));
  const until = left > 3600 ? `until ${read.expires.slice(0, 10)}` : left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left to sign` : "expired";
  return (
    <div className="stack">
      {fresh ? <div className="warning">⚠ Your key hasn't signed for {read.shop.name} before. Check it's the shop you meant.</div> : null}
      <div className="receipt">
        {read.kind === "buy" ? (
          <div className="who spread">
            {read.by ? (
              <span className="agent">
                <i>{read.by.slice(0, 1).toUpperCase()}</i>
                {read.by} asks to pay
              </span>
            ) : (
              <span className="agent">You're paying</span>
            )}
            {read.allow ? <span className="pill info">under an allowance</span> : null}
          </div>
        ) : null}
        <div className="shop">{read.shop.name}</div>
        <div className="muted small">{read.shop.id}</div>
        {read.kind === "buy" ? (
          <>
            <div className="lines">
              {(compact ? read.items.slice(0, 3) : read.items).map((item, index) => (
                <div className="line" key={index}>
                  <span>
                    {item.qty} × {item.name}
                  </span>
                  <span>{amount((Number(item.price) * item.qty).toFixed(2), read.currency)}</span>
                </div>
              ))}
              {compact && read.items.length > 3 ? <div className="muted">and {read.items.length - 3} more</div> : null}
            </div>
            <div className="total">
              <span>Total</span>
              <span>{amount(read.total, read.currency)}</span>
            </div>
          </>
        ) : read.kind === "link" ? (
          <div className="lines">
            <div>Link your PayPal at {read.shop.name} to this key.</div>
            <div className="muted">From then on, this key's signature pays for your carts there.</div>
          </div>
        ) : (
          <>
            <div className="lines">
              <div>
                PureStrings may pay here on its own, for {read.for}
                {read.by ? <b>, for {read.by} only</b> : null}:
              </div>
              <div className="line">
                <span>Each payment, at most</span>
                <span>{amount(read.each, read.currency)}</span>
              </div>
              <div className="line">
                <span>In all, each {read.per}</span>
                <span>{amount(read.total, read.currency)}</span>
              </div>
            </div>
            <div className="muted">Anything more comes to your key.</div>
          </>
        )}
        <div className="fine">Signed exactly as written · {until}</div>
      </div>
    </div>
  );
}
