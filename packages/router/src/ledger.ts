/**
 * Every model call this run made, in order.
 *
 * Kept because "why did this test cost forty cents" is a question a customer
 * will ask in a POC, and the answer has to be a table, not a shrug.
 */

import type { Provenance } from "@testsky/engine-core";

export interface LedgerEntry extends Provenance {
  at: number;
  purpose: "ground" | "assert" | "extract" | "plan" | "popup";
  stepId?: string;
  /** What the model answered, word for word: a report that shows only what a call cost cannot say why a run went as it did. */
  answer?: string;
}

export class CostLedger {
  private readonly entries: LedgerEntry[] = [];

  record(purpose: LedgerEntry["purpose"], provenance: Provenance, stepId?: string, answer?: string): void {
    const entry: LedgerEntry = { ...provenance, at: Date.now(), purpose };
    if (stepId !== undefined) entry.stepId = stepId;
    if (answer !== undefined) entry.answer = answer;
    this.entries.push(entry);
  }

  all(): readonly LedgerEntry[] {
    return this.entries;
  }

  totalUsd(): number {
    return this.entries.reduce((sum, entry) => sum + entry.usd, 0);
  }

  totalLatencyMs(): number {
    return this.entries.reduce((sum, entry) => sum + entry.latencyMs, 0);
  }

  /** Tokens, for when nobody has configured a price and the bill is still
   *  the question. */
  totalTokens(): { in: number; out: number } {
    return this.entries.reduce(
      (sum, entry) => ({ in: sum.in + (entry.tokensIn ?? 0), out: sum.out + (entry.tokensOut ?? 0) }),
      { in: 0, out: 0 },
    );
  }

  /** Calls per tier, so a regression in the ladder is visible at a glance. */
  byTier(): Record<number, number> {
    const counts: Record<number, number> = {};
    for (const entry of this.entries) counts[entry.tier] = (counts[entry.tier] ?? 0) + 1;
    return counts;
  }
}
