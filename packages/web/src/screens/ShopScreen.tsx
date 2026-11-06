import { useEffect, useState } from "react";
import { api, describeError } from "../api.ts";
import { useResource } from "../hooks.ts";
import { useKeyLink } from "../link.tsx";
import { Hold } from "../parts/Hold.tsx";
import { Receipt } from "../parts/Receipt.tsx";
import { StatusPill } from "../parts/Status.tsx";
import { amount } from "../signable.ts";
import type { Info, Product, SignView } from "../types.ts";
import { modelContext } from "../webmcp.ts";

/**
 * Bean & Leaf, the demo shop, as your assistants see it: search, put a cart together and ask to pay. You can shop
 * here yourself; the cart goes to your key all the same. In a browser with WebMCP, its AI agent gets these as tools.
 */
export function ShopScreen({ info }: { readonly info: Info | null }) {
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState("");
  const found = useResource(() => api.search(asked), []);
  const [cart, setCart] = useState<ReadonlyMap<string, { product: Product; qty: number }>>(new Map());
  const [payment, setPayment] = useState<SignView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const link = useKeyLink();
  const payments = useResource(() => (payment ? api.signs("buy") : Promise.resolve([])), ["sign"]);
  const now = payments.data?.find((one) => one.id === payment?.id) ?? payment;

  useEffect(() => {
    void found.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked]);

  const add = (product: Product, change: number) =>
    setCart((before) => {
      const next = new Map(before);
      const qty = (next.get(product.sku)?.qty ?? 0) + change;
      if (qty <= 0) next.delete(product.sku);
      else next.set(product.sku, { product, qty: Math.min(qty, 99) });
      return next;
    });
  const lines = [...cart.values()];
  const total = lines.reduce((sum, line) => sum + Number(line.product.price) * line.qty, 0);
  const shop = found.data?.found[0];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{shop?.shop.name ?? "The shop"}</h1>
          <p>The demo shop your assistants buy at. It prices every cart itself and charges your PayPal only for what your key signed.</p>
        </div>
        <div className="row">
          {info?.paypal ? <span className="pill info">PayPal {info.paypal}</span> : <span className="pill bad">PayPal not set up</span>}
          {modelContext() ? <span className="pill good">WebMCP tools on</span> : null}
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 2fr) minmax(280px, 1fr)" }}>
        <div className="card stack">
          <form
            className="row"
            style={{ flexWrap: "nowrap" }}
            onSubmit={(event) => {
              event.preventDefault();
              setAsked(query);
            }}
          >
            <input className="input" placeholder="Search: decaf, green tea, filters…" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search the shop" />
            <button type="submit" className="btn">
              Search
            </button>
          </form>
          <div className="products">
            {(shop?.products ?? []).map((product) => (
              <div key={product.sku} className="product">
                <b>{product.name}</b>
                <span className="muted small mono">{product.sku}</span>
                <div className="spread">
                  <span className="mono">{amount(product.price, product.currency)}</span>
                  <button type="button" className="btn" onClick={() => add(product, 1)}>
                    Add
                  </button>
                </div>
              </div>
            ))}
          </div>
          {shop && !shop.products.length ? <div className="empty">Nothing fits that.</div> : null}
          {found.error ? <div className="error">{found.error}</div> : null}
        </div>

        <div className="stack">
          <div className="card stack">
            <h2>Your cart</h2>
            {lines.length ? (
              <ul className="list">
                {lines.map(({ product, qty }) => (
                  <li key={product.sku}>
                    <span style={{ flex: 1 }}>{product.name}</span>
                    <button type="button" className="btn quiet" onClick={() => add(product, -1)} aria-label={`One less ${product.name}`}>
                      −
                    </button>
                    <span className="mono">{qty}</span>
                    <button type="button" className="btn quiet" onClick={() => add(product, 1)} aria-label={`One more ${product.name}`}>
                      +
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="empty">Add something.</div>
            )}
            <div className="spread">
              <b>Total</b>
              <b className="mono">{amount(total.toFixed(2), shop?.products[0]?.currency ?? "USD")}</b>
            </div>
            <button
              type="button"
              className="btn primary"
              disabled={!lines.length}
              onClick={() => {
                setError(null);
                void api.buy(lines.map(({ product, qty }) => ({ sku: product.sku, qty }))).then(
                  (made) => {
                    setPayment(made);
                    setCart(new Map());
                  },
                  (caught: unknown) => setError(describeError(caught)),
                );
              }}
            >
              Ask to pay
            </button>
            {error ? <div className="error">{error}</div> : null}
          </div>
          {now ? (
            <div className="card stack">
              <div className="spread">
                <h2>Your payment</h2>
                <StatusPill status={now.status} />
              </div>
              <Receipt text={now.text} compact />
              {now.status === "waiting" && link.screen?.type === "sign" && link.screen.id === now.id ? (
                <div className="spread">
                  <span className="muted small">Hold your key for two seconds to pay.</span>
                  <Hold onSign={() => void link.sign()} onRefuse={link.decline} disabled={!link.signer?.ok} />
                </div>
              ) : null}
              {now.status === "failed" ? <div className="error">{now.error}</div> : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
