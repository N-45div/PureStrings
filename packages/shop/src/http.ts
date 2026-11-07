import { createHash, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import type { Order } from "./store.ts";

/** What the shop's routes share: how they answer, read a body, show an order, and compare a secret. */

export type Status = 200 | 201 | 202 | 400 | 401 | 402 | 403 | 404 | 409 | 410 | 502 | 503;
export const fail = (c: Context, status: Status, error: string) => c.json({ error }, status);

export async function body(c: Context): Promise<Record<string, unknown>> {
  const parsed: unknown = await c.req.json().catch(() => null);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

export const orderView = (order: Order) => ({
  id: order.id,
  payment: order.paymentId,
  cart: order.cartId,
  fingerprint: order.fingerprint,
  status: order.status,
  total: order.total,
  currency: order.currency,
  paypal: { orderId: order.paypalOrderId, captureId: order.captureId },
  error: order.error,
  allowance: order.allowance,
  createdAt: order.createdAt,
  updatedAt: order.updatedAt,
});
/** Whether two secrets match, in the same time whatever they hold. */
export function same(given: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}
