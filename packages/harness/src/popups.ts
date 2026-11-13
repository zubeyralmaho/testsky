/**
 * The pop-up rules an organisation shares, as its control plane holds them.
 *
 * Read before every job, like the heal decisions: somebody may have changed
 * them since the last run, and a runner that remembered would answer prompts
 * the old way until it restarted. A test's own `policy.popups` still goes on
 * top, and the built-in defaults fill whatever neither says.
 */

import { knownPopupRules, type PopupRules } from "@testsky/artifact";

import type { ControlPlaneRequest } from "./decisions.ts";

export interface FetchedPopupRules {
  rules: Partial<PopupRules>;
  /** Why none could be read, in one line for a log. Absent when it worked. */
  error?: string;
}

/**
 * Never throws, and never holds a run up for long: without the shared rules a
 * run still has the defaults and the test's own, which is what it had before
 * there was anything to share.
 */
export async function fetchPopupRules(request: ControlPlaneRequest, timeoutMs = 3000): Promise<FetchedPopupRules> {
  try {
    const response = await request("/v1/popup-rules", { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { rules: {}, error: `the control plane answered ${response.status}` };
    const body = (await response.json()) as { rules?: unknown } | null;
    return { rules: knownPopupRules(body?.rules) };
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    return { rules: {}, error: cause ?? (error as Error).message };
  }
}
