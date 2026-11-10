/** What the PureStrings API answers with, as the app reads it. */

export interface Info {
  readonly name: string;
  readonly version: string;
  readonly publicUrl: string;
  readonly token: boolean;
  readonly shop: string | null;
  readonly paypal: "sandbox" | "live" | null;
  readonly model: string | null;
  readonly auditor: boolean;
  readonly mcp: string;
  /** The USB port PureStrings links a button on itself, when the button is plugged into its machine. */
  readonly usb?: string | null;
}

export type SignStatus = "waiting" | "signed" | "paid" | "linked" | "active" | "stopped" | "declined" | "expired" | "failed";

export interface Payee {
  readonly id: string;
  readonly name: string;
}

export interface PaymentLine {
  readonly name: string;
  readonly qty: number;
  readonly price: string;
}

/** What a key signed, as the server read it from the text. */
export type Signed =
  | { readonly kind: "buy"; readonly id: string; readonly allow?: string; readonly by?: string; readonly shop: Payee; readonly cart: string; readonly items: readonly PaymentLine[]; readonly total: string; readonly currency: string; readonly expires: string }
  | { readonly kind: "link"; readonly id: string; readonly shop: Payee; readonly key: string; readonly expires: string }
  | { readonly kind: "allow"; readonly id: string; readonly shop: Payee; readonly for: string; readonly by?: string; readonly agent: string; readonly each: string; readonly total: string; readonly per: "day" | "week" | "month"; readonly currency: string; readonly expires: string };

export interface SignView {
  readonly id: string;
  readonly kind: "buy" | "link" | "allow";
  readonly text: string;
  readonly status: SignStatus;
  readonly agent: string | null;
  readonly shop: string;
  readonly expires: string;
  readonly signature: string | null;
  readonly key: string | null;
  readonly result: unknown;
  readonly error: string | null;
  readonly createdAt: string;
  readonly signedAt: string | null;
  readonly line: string;
  readonly signed: Signed | null;
}

export interface AllowanceView extends SignView {
  /** "$12.00 of $50.00 this week", while it's active. */
  readonly use: string | null;
}

export interface Agent {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly lastSeenAt: string | null;
}

export interface AddedAgent {
  readonly agent: Agent;
  readonly token: string;
  readonly mcp: { readonly url: string; readonly config: unknown; readonly claudeCode: string };
}

export interface Signer {
  readonly key: string;
  readonly fingerprint: string;
  readonly name: string;
  readonly deviceId: string | null;
  readonly createdAt: string;
  readonly lastSignedAt: string | null;
}

export interface Device {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly lastSeenAt: string | null;
  readonly signer: Signer | null;
}

export interface Product {
  readonly sku: string;
  readonly name: string;
  readonly price: string;
  readonly currency: string;
  readonly description?: string;
}

export interface Found {
  readonly url: string;
  readonly shop: Payee;
  readonly products: readonly Product[];
}

export type Verdict = "signed" | "allowed" | "unsigned" | "mismatch";

export interface Finding {
  readonly charge: { readonly captureId: string; readonly orderId: string | null; readonly invoiceId: string | null; readonly amount: string; readonly currency: string; readonly status: string; readonly at: string };
  readonly verdict: Verdict;
  readonly why: string;
  readonly signId: string | null;
  readonly draft: string | null;
  readonly flagged: boolean;
}

export interface AuditView {
  readonly checkedAt: string | null;
  readonly events: boolean;
  readonly note: string | null;
  readonly findings: readonly Finding[];
}
