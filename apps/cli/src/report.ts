/**
 * The run, printed.
 *
 * A terminal summary is the whole report in W1; the step-indexed video and the
 * HTML report arrive in W6. What must already be true is the wording: the
 * outcome line says what happened in the taxonomy's own words, so nobody reads
 * "out of budget" as "your app is broken".
 */

import { accusesApp, describeOutcome, type TestResult } from "@testsky/executor";
import type { KeptRun } from "@testsky/harness";
import { CostLedger, type LedgerEntry } from "@testsky/router";

export const GREEN = "\u001b[32m";
export const RED = "\u001b[31m";
export const AMBER = "\u001b[33m";
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

function colourFor(outcome: TestResult["outcome"]): string {
  if (outcome === "PASS" || outcome === "HEALED_PASS") return GREEN;
  if (accusesApp(outcome)) return RED;
  return AMBER;
}

/** What a run read off the screen, by name: the last step to read each, as one that found nothing does not erase what another did. */
export function readOffTheScreen(steps: { extracted?: Record<string, unknown> }[]): Record<string, unknown> {
  const read: Record<string, unknown> = {};
  for (const { extracted } of steps) {
    for (const [name, value] of Object.entries(extracted ?? {})) {
      if (value !== null && value !== undefined && value !== "") read[name] = value;
    }
  }
  return read;
}

/** What a lane says of its run, before there is a report and again with one: both the same, as a second write replaces the first. */
export function laneAnswer(result: TestResult, usd: number) {
  return { outcome: result.outcome, detail: result.detail, extracted: readOffTheScreen(result.steps), usd, ms: result.finishedAt - result.startedAt };
}

/** Where a run was, and where it left what it made. */
export interface RunPlace {
  /** The test file, as a full path, when it is known: a run's folder does not say. */
  path?: string;
  platform: string;
  device: string;
  /** The run's folder: events, frames, result and report. */
  dir?: string;
  report?: string;
}

/**
 * The run as `--json` answers it: a superset of the lane's answer, with the
 * taxonomy's own words beside the outcome so that whoever reads it -- often
 * an agent -- does not read "could not tell" as "the app is broken".
 */
export function runAnswer(result: TestResult, ledger: CostLedger, place: RunPlace) {
  return {
    ...laneAnswer(result, ledger.totalUsd()),
    exitCode: exitCodeFor(result),
    meaning: describeOutcome(result.outcome),
    accusesApp: accusesApp(result.outcome),
    test: result.testId,
    ...place,
    steps: result.steps.map((step) => ({
      id: step.stepId,
      outcome: step.outcome,
      detail: step.detail,
      actions: step.actions,
      ms: step.finishedAt - step.startedAt,
      usd: step.usd,
      ...(step.fromCache ? { fromCache: true } : {}),
      ...(step.healed ? { healed: true } : {}),
      ...(step.extracted ? { extracted: step.extracted } : {}),
    })),
    cache: result.cache,
    popups: result.popups,
    modelCalls: ledger.all().length,
  };
}

export function printReport(result: TestResult, ledger: CostLedger): void {
  const cachedMark = (step: TestResult["steps"][number]) =>
    step.fromCache ? ` ${DIM}[remembered]${RESET}` : step.healed ? ` ${AMBER}[healed]${RESET}` : "";
  const seconds = ((result.finishedAt - result.startedAt) / 1000).toFixed(1);
  const colour = colourFor(result.outcome);

  console.log("");
  for (const step of result.steps) {
    const mark = step.outcome === "PASS" ? `${GREEN}ok${RESET}` : `${colourFor(step.outcome)}${step.outcome}${RESET}`;
    const cost = step.usd > 0 ? ` ${DIM}$${step.usd.toFixed(4)}${RESET}` : "";
    const took = ((step.finishedAt - step.startedAt) / 1000).toFixed(1);
    console.log(`  ${mark}  ${step.stepId} ${DIM}(${step.actions} actions, ${took}s)${RESET}${cost}${cachedMark(step)}`);
    if (step.detail) console.log(`      ${DIM}${step.detail}${RESET}`);
    if (step.extracted) console.log(`      ${DIM}extracted: ${JSON.stringify(step.extracted)}${RESET}`);
  }

  console.log("");
  console.log(`  ${colour}${describeOutcome(result.outcome)}${RESET} -- ${result.detail}`);
  const tiers = Object.entries(ledger.byTier())
    .map(([tier, count]) => `tier ${tier}: ${count}`)
    .join(", ");
  const tokens = ledger.totalTokens();
  // Tokens stand in for a price only when something was spent on them: a run
  // that asked no model cost nothing, and says so.
  const spent = !ledger.all().length
    ? "$0"
    : ledger.totalUsd() > 0
      ? `$${ledger.totalUsd().toFixed(4)}`
      : `${(tokens.in / 1000).toFixed(1)}k in / ${tokens.out} out tokens`;
  console.log(
    `  ${DIM}${seconds}s, ${spent}, ${ledger.all().length} model calls${tiers ? ` (${tiers})` : ""}${RESET}`,
  );

  // The memory's whole justification, in one line: how much of this run was
  // free, and what it noticed had changed.
  const { steps: seen, replayed, heals } = result.cache;
  if (seen) {
    const share = Math.round((replayed / seen) * 100);
    console.log(
      `  ${DIM}${replayed}/${seen} steps from memory (${share}%)${heals ? `, ${heals} heal${heals > 1 ? "s" : ""} to review` : ""}${RESET}`,
    );
  }
  console.log("");
}

/**
 * Exit codes CI can act on.
 *
 * 1 means the app under test may be broken. 2 means we could not tell, which
 * is a different conversation and must not wake anyone at 3am. Both verdicts
 * share 1: CI needs to know whether to page somebody, and the report is where
 * the difference between them is explained.
 */
export function exitCodeFor(result: TestResult): number {
  if (result.outcome === "PASS" || result.outcome === "HEALED_PASS") return 0;
  if (accusesApp(result.outcome)) return 1;
  return 2;
}

/** The ledger a kept run's calls make again: the same totals, for a run read back from its folder. */
export function ledgerOf(calls: readonly LedgerEntry[] = []): CostLedger {
  const ledger = new CostLedger();
  for (const { purpose, stepId, answer, at: _at, ...provenance } of calls) ledger.record(purpose, provenance, stepId, answer);
  return ledger;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
/** A table cell: one line, and no pipe to end it early. */
const cell = (text: string) => text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();

/**
 * A kept run in Markdown: for a pull request's comment, an issue, a chat. The
 * outcome in the taxonomy's words comes first, so that "could not tell" is
 * never pasted somewhere as "the app is broken".
 */
export function markdownReport(kept: KeptRun): string {
  const title = String(kept.meta.title ?? kept.meta.test ?? "a run");
  const device = kept.meta.device as { id?: string; platform?: string } | undefined;
  const on = device?.id ? ` on ${[device.platform, device.id].filter(Boolean).join(" ")}` : "";
  const result = kept.result;
  if (!result) {
    const last = kept.lastStep ? `; the last step it started was \`${kept.lastStep}\`` : "";
    return [
      `### ${title}: no result`,
      "",
      `The run${on} has no result yet: it is still going, or it was stopped before its verdict. ${kept.events} event(s) so far${last}.`,
      "",
    ].join("\n");
  }
  const ledger = ledgerOf(result.calls);
  const lines = [
    `### ${title}: ${result.outcome}`,
    "",
    `**${describeOutcome(result.outcome)}**${on}. ${result.detail}`,
    "",
    "| Step | Outcome | Time | |",
    "|---|---|---|---|",
    ...result.steps.map((step) => {
      const marks = [step.fromCache ? "remembered" : "", step.healed ? "healed" : "", step.outcome !== "PASS" ? step.detail : ""];
      return `| \`${cell(step.stepId)}\` | ${step.outcome} | ${seconds(step.finishedAt - step.startedAt)} | ${cell(marks.filter(Boolean).join("; "))} |`;
    }),
    "",
    `${seconds(result.finishedAt - result.startedAt)}, $${ledger.totalUsd().toFixed(4)}, ${ledger.all().length} model call(s)` +
      (result.cache?.steps ? `, ${result.cache.replayed}/${result.cache.steps} steps from memory` : "") +
      (result.cache?.heals ? `, ${result.cache.heals} heal(s) to review` : ""),
  ];
  const read = readOffTheScreen(result.steps);
  if (Object.keys(read).length) lines.push("", `Read off the screen: \`${cell(JSON.stringify(read))}\``);
  if (kept.report) lines.push("", `Report: \`${kept.report}\``);
  return `${lines.join("\n")}\n`;
}
