import { cents, decimal, MAX_ALLOWANCE_DAYS, type Period, PERIODS } from "@purestrings/core";
import { jsonIn, type Model } from "./model.ts";

/**
 * An allowance from what you say ("coffee, up to $20 each and $50 a week"): the model writes the limits, and your
 * key shows (or says) them before you sign. Whatever the model writes, what your key signs is what you agree to.
 */

export interface Limits {
  readonly for: string;
  readonly each: string;
  readonly total: string;
  readonly per: Period;
  readonly days: number;
}

const GUIDE = `You turn what the person says into an allowance: how much their payment assistant may spend at a shop on its own, without asking them each time. Answer with JSON only:
{"for": "<what it's for, in 1 to 4 words, like Groceries>", "each": "<the most for one payment, like 20.00>", "total": "<the most for all payments in a period, like 50.00>", "per": "day" | "week" | "month", "days": <how many days it lasts, from 1 to ${MAX_ALLOWANCE_DAYS}>}
Amounts are plain numbers with two decimals, no currency sign. When they give one amount, it's both "each" and "total". When they don't say a period, it's "week". When they don't say how long, "days" is 30. "each" is never more than "total".`;

/** The limits in a model's answer, checked: amounts, a period, and a length an allowance can have. */
export function limitsFrom(answer: unknown): Limits {
  const { for: label, each, total, per, days } = (answer ?? {}) as Record<string, unknown>;
  const amount = (value: unknown) => (typeof value === "number" ? cents(value.toFixed(2)) : typeof value === "string" ? cents(value.replace(/^\$/, "").trim()) : null);
  const eachCents = amount(each);
  const totalCents = amount(total) ?? eachCents;
  if (eachCents === null || eachCents === 0 || totalCents === null || totalCents === 0) throw new Error("The allowance needs amounts: the most for one payment, and the most in all.");
  if (typeof per !== "string" || !(per in PERIODS)) throw new Error("The allowance's limit runs per day, week or month.");
  const length = typeof days === "number" && Number.isInteger(days) ? days : 30;
  const name = typeof label === "string" && label.trim() ? label.trim().replace(/\s+/g, " ").slice(0, 40) : "Shopping";
  return { for: name, each: decimal(Math.min(eachCents, totalCents)), total: decimal(totalCents), per: per as Period, days: Math.min(Math.max(length, 1), MAX_ALLOWANCE_DAYS) };
}

/** The limits for what was said, written by the model and checked. */
export async function limitsFromWords(model: Model, said: string): Promise<Limits> {
  return limitsFrom(jsonIn(await model.ask(GUIDE, said.slice(0, 500), { maxTokens: 200 })));
}
