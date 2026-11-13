import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { TestResult } from "@testsky/executor";
import { latestRun, readRun, RunRecord } from "@testsky/harness";
import { CostLedger } from "@testsky/router";

import { checkSource, keptAnswer } from "./inspect.ts";
import { markdownReport } from "./report.ts";

const DEVICE = { id: "R58M", platform: "android", osVersion: "14", kind: "physical" };

const RESULT: TestResult = {
  testId: "checkout",
  outcome: "FAIL_ASSERT",
  detail: "the order number is not visible",
  steps: [
    { stepId: "cart", outcome: "PASS", detail: "the cart shows one item", actions: 1, usd: 0.001, startedAt: 1000, finishedAt: 3000, fromCache: true },
    { stepId: "pay", outcome: "FAIL_ASSERT", detail: "the order number is not visible", actions: 2, usd: 0.002, startedAt: 3000, finishedAt: 9000, extracted: { total: "$146.00" } },
  ],
  startedAt: 1000,
  finishedAt: 9000,
  usd: 0.003,
  cache: { steps: 2, replayed: 1, heals: 0 },
  popups: 0,
};

async function keptRun(root: string, at: number, result: TestResult): Promise<string> {
  const record = new RunRecord(root, "checkout", at, DEVICE.id);
  await record.open({ test: "checkout", title: "Pay for the cart", device: DEVICE, engine: "fake", startedAt: at });
  record.write({ at, kind: "step_started", stepId: "cart", message: "tap the cart icon" });
  record.write({ at, kind: "step_started", stepId: "pay", message: "pay" });
  const ledger = new CostLedger();
  ledger.record("assert", { tier: 1, model: "fake", usd: 0.003, latencyMs: 5, usedTree: false, channel: "vision" }, "pay");
  await record.close(result, ledger);
  return record.dir;
}

test("a test file is checked the way a run reads it, and a broken one says where", () => {
  const ok = checkSource("id: cart\ntargets: [{ platform: android, app: com.acme.shop }]\nsteps:\n  - do: tap the cart icon\n    expect: the cart is open\n", "/t/cart.testsky.yaml");
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.test?.steps, [{ id: "tap-the-cart-icon", do: "tap the cart icon", expect: "the cart is open" }]);
  const broken = checkSource("id: cart\ntargets: []\nsteps: []\n", "/t/cart.testsky.yaml");
  assert.equal(broken.ok, false);
  assert.match(broken.error ?? "", /^\/t\/cart\.testsky\.yaml: /);
});

test("a kept run is read back: its answer, its Markdown, and the newest of several", async () => {
  const root = await mkdtemp(join(tmpdir(), "testsky-runs-"));
  await keptRun(root, Date.parse("2026-11-13T09:00:00.000Z"), { ...RESULT, outcome: "PASS", detail: "all steps passed" });
  const dir = await keptRun(root, Date.parse("2026-11-13T10:00:00.000Z"), RESULT);
  assert.equal(await latestRun(root), dir);

  const answer = keptAnswer(await readRun(dir));
  assert.deepEqual(
    [answer.outcome, answer.exitCode, answer.accusesApp, answer.device, answer.platform, answer.usd, answer.modelCalls],
    ["FAIL_ASSERT", 1, true, "R58M", "android", 0.003, 1],
  );
  assert.deepEqual(answer.extracted, { total: "$146.00" });

  const markdown = markdownReport(await readRun(dir));
  assert.match(markdown, /^### Pay for the cart: FAIL_ASSERT\n/);
  assert.match(markdown, /\| `cart` \| PASS \| 2\.0s \| remembered \|/);
  assert.match(markdown, /\| `pay` \| FAIL_ASSERT \| 6\.0s \| the order number is not visible \|/);
  assert.match(markdown, /1\/2 steps from memory/);
});

test("a run with no result yet says how far it got", async () => {
  const root = await mkdtemp(join(tmpdir(), "testsky-runs-"));
  const record = new RunRecord(root, "checkout", Date.now(), DEVICE.id);
  await record.open({ test: "checkout", title: "Pay for the cart", device: DEVICE, engine: "fake", startedAt: Date.now() });
  record.write({ at: Date.now(), kind: "step_started", stepId: "pay", message: "pay" });
  // Written as it comes, with the run still going: read once the line is on disk.
  for (const until = Date.now() + 10_000; (await readRun(record.dir)).events === 0 && Date.now() < until; ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const answer = keptAnswer(await readRun(record.dir));
  assert.deepEqual([answer.outcome, answer.exitCode, answer.lastStep, answer.events], ["NO_RESULT", 2, "pay", 1]);
  assert.match(markdownReport(await readRun(record.dir)), /no result yet.*last step it started was `pay`/s);
});
