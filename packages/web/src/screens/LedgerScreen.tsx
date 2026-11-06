import { CellStyleModule, ClientSideRowModelModule, type ColDef, CsvExportModule, type GridApi, type ICellRendererParams, ModuleRegistry, NumberFilterModule, PinnedRowModule, QuickFilterModule, type RowClassRules, RowStyleModule, TextFilterModule, themeQuartz, TooltipModule } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { api } from "../api.ts";
import { useResource } from "../hooks.ts";
import { StatusPill, VerdictPill } from "../parts/Status.tsx";
import { amount } from "../signable.ts";
import type { Finding, Info, SignStatus, SignView } from "../types.ts";

// Only what the ledger uses: rows in the page, search, filters, the pinned total, red rows, tooltips, CSV.
ModuleRegistry.registerModules([ClientSideRowModelModule, QuickFilterModule, TextFilterModule, NumberFilterModule, PinnedRowModule, RowStyleModule, CellStyleModule, TooltipModule, CsvExportModule]);

/** AG Grid's Quartz theme in PureStrings' paper and ink, following light and dark with the page. */
const theme = themeQuartz.withParams({
  backgroundColor: "var(--card)",
  foregroundColor: "var(--ink)",
  headerBackgroundColor: "var(--sunk)",
  headerTextColor: "var(--muted)",
  borderColor: "var(--line)",
  rowHoverColor: "var(--brass-soft)",
  accentColor: "var(--brass)",
  oddRowBackgroundColor: "var(--card)",
  fontFamily: "var(--sans)",
  headerFontWeight: 650,
  fontSize: 13.5,
  spacing: 7,
  wrapperBorderRadius: 12,
});

/** One line of the ledger: a payment asked for here, or a charge PayPal made that nothing here asked for. */
interface Row {
  readonly id: string;
  readonly at: string;
  readonly agent: string | null;
  readonly shop: string;
  readonly what: string;
  readonly total: number;
  readonly currency: string;
  readonly status: SignStatus | "charged" | "refunded";
  readonly signedBy: string;
  readonly paypal: string;
  readonly finding: Finding | null;
  readonly error: string | null;
}

type Show = "all" | "paid" | "waiting" | "flagged";

function rowsOf(payments: readonly SignView[], findings: readonly Finding[], keyNames: ReadonlyMap<string, string>): Row[] {
  const bySign = new Map(findings.filter((finding) => finding.signId).map((finding) => [finding.signId!, finding]));
  const rows: Row[] = payments.map((payment) => {
    const signed = payment.signed?.kind === "buy" ? payment.signed : null;
    const order = payment.result as { paypal?: { orderId?: string | null; captureId?: string | null } } | null;
    return {
      id: payment.id,
      at: payment.createdAt,
      agent: payment.agent,
      shop: signed?.shop.name ?? payment.shop,
      what: signed ? signed.items.map((item) => `${item.qty}× ${item.name}`).join(", ") : payment.line,
      total: signed ? Number(signed.total) : 0,
      currency: signed?.currency ?? "USD",
      status: payment.status,
      signedBy: signed?.allow ? "an allowance" : payment.key ? (keyNames.get(payment.key) ?? "a key of yours") : "",
      paypal: order?.paypal?.captureId ?? order?.paypal?.orderId ?? "",
      finding: bySign.get(payment.id) ?? null,
      error: payment.error,
    };
  });
  // Charges PayPal made that no payment here asked for: the ones the auditor exists to catch.
  for (const finding of findings) {
    if (finding.signId && payments.some((payment) => payment.id === finding.signId)) continue;
    rows.push({
      id: finding.charge.captureId,
      at: finding.charge.at,
      agent: null,
      shop: "Bean & Leaf",
      what: finding.why,
      total: Number(finding.charge.amount),
      currency: finding.charge.currency || "USD",
      // A charge nobody signed that PayPal has since given back isn't one to worry about.
      status: /REFUNDED|REVERSED/.test(finding.charge.status) ? "refunded" : "charged",
      signedBy: "nobody",
      paypal: finding.charge.captureId,
      finding,
      error: null,
    });
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at));
}

export function LedgerScreen({ info }: { readonly info: Info | null }) {
  const payments = useResource(() => api.signs("buy"), ["sign"]);
  const audit = useResource(() => (info?.auditor ? api.audit() : Promise.resolve(null)), ["audit"]);
  const keys = useResource(() => api.keys(), ["keys"]);
  const [search, setSearch] = useState("");
  const [show, setShow] = useState<Show>("all");
  const grid = useRef<GridApi<Row> | null>(null);

  const keyNames = useMemo(() => new Map((keys.data ?? []).map((key) => [key.key, `${key.name} (${key.fingerprint.slice(0, 9)})`])), [keys.data]);
  const rows = useMemo(() => rowsOf(payments.data ?? [], audit.data?.findings ?? [], keyNames), [payments.data, audit.data, keyNames]);
  const shown = useMemo(
    () => rows.filter((row) => (show === "all" ? true : show === "paid" ? row.status === "paid" : show === "waiting" ? row.status === "waiting" : Boolean(row.finding?.flagged))),
    [rows, show],
  );
  const paidTotal = shown.filter((row) => row.status === "paid").reduce((sum, row) => sum + row.total, 0);
  const flagged = rows.filter((row) => row.finding?.flagged).length;

  const columns = useMemo<ColDef<Row>[]>(
    () => [
      { field: "at", headerName: "When", width: 135, sort: "desc", valueFormatter: (p) => (p.node?.rowPinned ? "" : p.value ? new Date(p.value as string).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "") },
      {
        field: "agent",
        headerName: "Asked by",
        width: 130,
        cellRenderer: (p: ICellRendererParams<Row>) =>
          p.node.rowPinned ? null : p.value ? (
            <span className="agent">
              <i>{String(p.value).slice(0, 1).toUpperCase()}</i>
              {String(p.value)}
            </span>
          ) : (
            <span className="muted">{p.data?.signedBy === "nobody" ? "nobody" : "you"}</span>
          ),
      },
      { field: "shop", headerName: "Shop", width: 115 },
      { field: "what", headerName: "What", flex: 1, minWidth: 220, tooltipField: "what" },
      {
        field: "total",
        headerName: "Amount",
        width: 100,
        type: "rightAligned",
        cellClass: "cell-amount",
        valueFormatter: (p) => amount(Number(p.value ?? 0).toFixed(2), p.data?.currency ?? "USD"),
      },
      {
        field: "status",
        headerName: "Status",
        width: 160,
        cellRenderer: (p: ICellRendererParams<Row>) =>
          p.node.rowPinned ? <b>paid in all</b> : p.value === "charged" ? <span className="pill bad">charged</span> : p.value === "refunded" ? <span className="pill">refunded</span> : p.value ? <StatusPill status={p.value as SignStatus} /> : null,
        tooltipValueGetter: (p) => p.data?.error ?? undefined,
      },
      { field: "signedBy", headerName: "Signed by", width: 165 },
      {
        headerName: "Auditor",
        width: 165,
        valueGetter: (p) => p.data?.finding?.verdict ?? "",
        cellRenderer: (p: ICellRendererParams<Row>) => (p.data?.finding ? <VerdictPill verdict={p.data.finding.verdict} flagged={p.data.finding.flagged} /> : p.node.rowPinned ? null : <span className="muted small">not charged yet</span>),
      },
      { field: "paypal", headerName: "PayPal", width: 160, cellClass: "mono" },
    ],
    [],
  );
  const rowClassRules = useMemo<RowClassRules<Row>>(() => ({ "row-flagged": (p) => Boolean(p.data?.finding?.flagged) }), []);
  const exportCsv = useCallback(() => grid.current?.exportDataAsCsv({ fileName: `purestrings-ledger-${new Date().toISOString().slice(0, 10)}.csv` }), []);

  return (
    <div className="page" style={{ maxWidth: 1240 }}>
      <div className="page-head">
        <div>
          <h1>Ledger</h1>
          <p>Every payment an assistant asked for, who signed it, and what PayPal's own record says. A charge nobody signed shows in red.</p>
        </div>
        <div className="row">
          {flagged ? <span className="pill bad">{flagged} flagged</span> : <span className="pill good">nothing flagged</span>}
          <button type="button" className="btn" onClick={exportCsv}>
            Export CSV
          </button>
        </div>
      </div>
      <div className="card stack">
        <div className="spread" style={{ flexWrap: "wrap" }}>
          <div className="tabs" role="group" aria-label="Show">
            {(["all", "paid", "waiting", "flagged"] as const).map((one) => (
              <button key={one} type="button" aria-pressed={show === one} onClick={() => setShow(one)}>
                {one === "all" ? "Everything" : one === "paid" ? "Paid" : one === "waiting" ? "Waiting" : "Flagged"}
              </button>
            ))}
          </div>
          <input className="input" style={{ maxWidth: 280 }} placeholder="Search the ledger" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search the ledger" />
        </div>
        <div className="ledger">
          <AgGridReact<Row>
            theme={theme}
            rowData={shown}
            columnDefs={columns}
            defaultColDef={{ resizable: true, sortable: true, filter: true }}
            getRowId={(p) => p.data.id}
            quickFilterText={search}
            rowClassRules={rowClassRules}
            pinnedBottomRowData={[{ id: "total", at: "", agent: null, shop: "", what: `${shown.filter((row) => row.status === "paid").length} payments`, total: paidTotal, currency: "USD", status: "paid", signedBy: "", paypal: "", finding: null, error: null }]}
            tooltipShowDelay={300}
            animateRows
            onGridReady={(event) => {
              grid.current = event.api;
            }}
            overlayNoRowsTemplate="<span>Nothing here yet.</span>"
          />
        </div>
      </div>
      {payments.error ? <div className="error">{payments.error}</div> : null}
    </div>
  );
}
