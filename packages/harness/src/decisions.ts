/**
 * Asking the control plane what people decided about a test's heals.
 *
 * Never throws, never waits long. Decisions correct the memory; they are not
 * a precondition for running it. The lock already holds every decision it has
 * heard before, so a control plane that is down, slow or mid-deploy costs a
 * run only the decisions made since the last one -- and a runner that refused
 * to test without them would turn an outage of the history service into an
 * outage of testing.
 */

import type { HealDecision, HealRecord } from "@testsky/artifact";
import type { Platform } from "@testsky/engine-core";

/**
 * How the caller reaches the control plane: a path in, a response out. The
 * runner hands over the function its every other request goes through, so
 * whatever that adds -- a credential, a proxy -- this gets too.
 */
export type ControlPlaneRequest = (path: string, init: { signal: AbortSignal }) => Promise<Response>;

export interface FetchedDecisions {
  decisions: HealDecision[];
  /** Why none could be read, in one line for a log. Absent when it worked. */
  error?: string;
}

export async function fetchHealDecisions(
  request: ControlPlaneRequest,
  testId: string,
  platform: Platform,
  timeoutMs = 3000,
): Promise<FetchedDecisions> {
  const path = `/v1/tests/${encodeURIComponent(testId)}/heal-decisions?platform=${encodeURIComponent(platform)}`;
  try {
    const response = await request(path, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { decisions: [], error: `the control plane answered ${response.status}` };
    const rows: unknown = await response.json();
    if (!Array.isArray(rows)) return { decisions: [], error: "the control plane's answer was not a list" };
    return { decisions: rows.flatMap(toDecision) };
  } catch (error) {
    // "fetch failed" says nothing; the cause says which of the usual three.
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    return { decisions: [], error: cause ?? (error as Error).message };
  }
}

/** One row as the control plane stores it, or nothing if it is not one. */
function toDecision(row: unknown): HealDecision[] {
  if (!row || typeof row !== "object") return [];
  const { step_id, status, before_json, after_json, reviewed_at, kind } = row as Record<string, unknown>;
  if (typeof step_id !== "string" || (status !== "accepted" && status !== "rejected")) return [];
  const before = side(before_json);
  const after = side(after_json);
  if (!before || !after) return [];
  return [{ step: step_id, status, before, after, ...(typeof reviewed_at === "string" ? { reviewedAt: reviewed_at } : {}), ...(kind === "astray" ? { kind } : {}) }];
}

function side(value: unknown): HealRecord["before"] | undefined {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as HealRecord["before"]) : undefined;
}
