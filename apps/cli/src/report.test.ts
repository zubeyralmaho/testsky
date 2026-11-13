import assert from "node:assert/strict";
import test from "node:test";

import { laneAnswer, readOffTheScreen, runAnswer } from "./report.ts";

test("a step that found nothing does not erase what another read", () => {
  assert.deepEqual(
    readOffTheScreen([
      { extracted: { meeting_link: "https://acme.webex.com/meet/pr1", ping: 0 } },
      {},
      { extracted: { meeting_link: "", server: null } },
      { extracted: { download: "94" } },
    ]),
    { meeting_link: "https://acme.webex.com/meet/pr1", ping: 0, download: "94" },
  );
});

test("a lane's answer carries what was read, as a caller reads a meeting link from it", () => {
  const result = { outcome: "PASS", detail: "all steps passed", startedAt: 1000, finishedAt: 4000, steps: [{ extracted: { meeting_link: "meet.google.com/abc-defg-hij" } }] } as unknown as Parameters<typeof laneAnswer>[0];
  assert.deepEqual(laneAnswer(result, 0.5), { outcome: "PASS", detail: "all steps passed", extracted: { meeting_link: "meet.google.com/abc-defg-hij" }, usd: 0.5, ms: 3000 });
});

test("--json answers with the lane's answer and more: the outcome in words, each step, where the run is", () => {
  const result = {
    testId: "checkout",
    outcome: "FAIL_GROUND",
    detail: "could not find the Pay button",
    startedAt: 1000,
    finishedAt: 9000,
    usd: 0,
    cache: { steps: 1, replayed: 0, heals: 0 },
    popups: 0,
    steps: [{ stepId: "pay", outcome: "FAIL_GROUND", detail: "could not find the Pay button", actions: 0, usd: 0, startedAt: 1000, finishedAt: 9000 }],
  } as unknown as Parameters<typeof runAnswer>[0];
  const ledger = { totalUsd: () => 0.002, all: () => [{}, {}] } as unknown as Parameters<typeof runAnswer>[1];
  const answer = runAnswer(result, ledger, { path: "/t/checkout.testsky.yaml", platform: "android", device: "R58M", dir: "/runs/x", report: "/runs/x/report.html" });
  assert.deepEqual(
    { outcome: answer.outcome, exitCode: answer.exitCode, accusesApp: answer.accusesApp, usd: answer.usd, ms: answer.ms, modelCalls: answer.modelCalls, report: answer.report },
    { outcome: "FAIL_GROUND", exitCode: 2, accusesApp: false, usd: 0.002, ms: 8000, modelCalls: 2, report: "/runs/x/report.html" },
  );
  assert.match(answer.meaning, /\S/, "the taxonomy's own words, so that could-not-tell is not read as broken");
  assert.deepEqual(answer.steps, [{ id: "pay", outcome: "FAIL_GROUND", detail: "could not find the Pay button", actions: 0, ms: 8000, usd: 0 }]);
});
