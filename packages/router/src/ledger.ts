/**
 * Every model call this run made, in order.
 *
 * Kept because "why did this test cost forty cents" is a question a customer
 * will ask in a POC, and the answer has to be a table, not a shrug. And
 * because "why did it press that" is the next question, and its answer is the
 * conversation itself: what the model was shown, what it thought, what it said.
 */

import { createHash } from "node:crypto";

import type { Provenance } from "@testsky/engine-core";

/** What a call asked, word for word. */
export interface Asked {
  /** The instructions every question of its kind starts with. */
  system: string;
  /** The question, as it was sent: with the screen's accessibility tree in it, when the tree went along. */
  user: string;
  /** Where in `user` the tree's own lines are, [from, to): a reader shows them apart from the words around them. */
  treeSpan?: [number, number];
  /** The picture it was shown, by its id in the ledger's pictures; absent when it was shown none. */
  image?: string;
}

export interface LedgerEntry extends Provenance {
  at: number;
  purpose: "ground" | "assert" | "extract" | "plan" | "popup";
  stepId?: string;
  /** What the model answered, word for word: a report that shows only what a call cost cannot say why a run went as it did. */
  answer?: string;
  /** What the model thought before it answered, word for word, when its host sent it back. */
  reasoning?: string;
  /** What it was asked. */
  asked?: Asked;
}

/** A call's words, the picture it was shown, and the tree lines in its question, as the router has them. */
export interface Exchange {
  system: string;
  user: string;
  /**
   * The picture it was shown: its id, from the bytes the screen came as
   * (`pictureId`), and the bytes a report shows -- small, since a run can
   * show a model hundreds of screens while it waits.
   */
  picture?: { id: string; bytes: Buffer };
  /** The tree's lines, exactly as they appear in `user`. */
  tree?: string;
  reasoning?: string;
}

/**
 * A picture's id, from the bytes it came as: the same screen shown to ten
 * calls is one picture, and a frame a run kept is known for the picture it is.
 */
export const pictureId = (bytes: Buffer): string => `picture-${createHash("sha1").update(bytes).digest("hex").slice(0, 16)}`;

export class CostLedger {
  private readonly entries: LedgerEntry[] = [];
  /**
   * The pictures the calls were shown, by id. Not part of an entry, which is
   * written out as JSON: a report embeds them, and a reader that has done with
   * them takes them out.
   */
  readonly pictures = new Map<string, Buffer>();

  record(purpose: LedgerEntry["purpose"], provenance: Provenance, stepId?: string, answer?: string, exchange?: Exchange): void {
    const entry: LedgerEntry = { ...provenance, at: Date.now(), purpose };
    if (stepId !== undefined) entry.stepId = stepId;
    if (answer !== undefined) entry.answer = answer;
    if (exchange) {
      if (exchange.reasoning) entry.reasoning = exchange.reasoning;
      const asked: Asked = { system: exchange.system, user: exchange.user };
      const from = exchange.tree ? exchange.user.indexOf(exchange.tree) : -1;
      if (exchange.tree && from !== -1) asked.treeSpan = [from, from + exchange.tree.length];
      if (exchange.picture) {
        asked.image = exchange.picture.id;
        this.pictures.set(asked.image, exchange.picture.bytes);
      }
      entry.asked = asked;
    }
    this.entries.push(entry);
  }

  all(): readonly LedgerEntry[] {
    return this.entries;
  }

  /** The pictures these calls were shown, taken out of the ledger: a long session is not left holding every screen it ever sent. */
  takePictures(calls: readonly LedgerEntry[]): Map<string, Buffer> {
    const taken = new Map<string, Buffer>();
    for (const call of calls) {
      const id = call.asked?.image;
      const bytes = id ? this.pictures.get(id) : undefined;
      if (id && bytes) taken.set(id, bytes);
    }
    for (const id of taken.keys()) this.pictures.delete(id);
    return taken;
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
