/**
 * The quality bar, in three numbers.
 *
 * We are not building this with a design partner, so nothing outside this
 * repository tells us whether a change made the agent better or worse. A
 * public benchmark will not either: AndroidWorld is saturated (claimed 99%
 * against a human baseline of 80%) and says nothing about the screens a
 * customer actually has.
 *
 * So: a fixed suite of real apps, run the same way every release, reporting
 * step success, cost per test and p95 step latency. A model, prompt or tier
 * change ships only if it does not make those three worse. The suite is the
 * argument; the numbers are how we lose it.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { isTestFile, parseTestFile } from "@testsky/artifact";
import { describeHolder, leaseDevice, type DeviceHandle, type Platform } from "@testsky/engine-core";
import { openLock, runOnce } from "@testsky/harness";

import { busyWithOthers, resolveDevice } from "./devices.ts";

const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

interface TestScore {
  test: string;
  runs: number;
  passed: number;
  stepsTotal: number;
  stepsPassed: number;
  usd: number;
  tokensIn: number;
  calls: number;
  latencies: number[];
  outcomes: string[];
}

const percentile = (values: number[], q: number): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};

export async function commandBench(argv: string[], flag: (argv: string[], name: string) => string | undefined): Promise<number> {
  const dir = argv[0] ?? "bench";
  const platform = (flag(argv, "platform") ?? "ios") as Platform;
  const runs = Number(flag(argv, "runs") ?? 1);
  const outPath = flag(argv, "out") ?? "bench.json";
  const useCache = argv.includes("--cache");

  const files = (await readdir(resolve(dir))).filter(isTestFile).sort();
  if (!files.length) {
    console.log(`  no tests in ${dir}/`);
    return 2;
  }

  const device = await resolveDevice(platform, flag(argv, "device"));
  const lease = await leaseDevice(device, `bench ${dir}`);
  if ("busy" in lease) {
    console.error(`the ${platform} device ${device.id} is in use${lease.busy ? ` by ${describeHolder(lease.busy)}` : ""}`);
    return 2;
  }
  const others = await busyWithOthers(device);
  if (others.length) {
    await lease.lease.release();
    console.error(`the ${platform} device ${device.id} is in use by another program: ${others.join("; ")}`);
    return 2;
  }
  try {
    return await benchOn(device, files, { dir, platform, runs, outPath, useCache });
  } finally {
    await lease.lease.release();
  }
}

async function benchOn(
  device: DeviceHandle,
  files: string[],
  { dir, platform, runs, outPath, useCache }: { dir: string; platform: Platform; runs: number; outPath: string; useCache: boolean },
): Promise<number> {
  console.log(`${DIM}${files.length} test(s) x ${runs} run(s) on ${platform} ${device.id}${RESET}\n`);

  const scores: TestScore[] = [];
  for (const file of files) {
    const path = join(resolve(dir), file);
    const test = parseTestFile(await readFile(path, "utf8"), path);
    if (!test.targets.some((target) => target.platform === platform)) continue;

    const score: TestScore = {
      test: test.id,
      runs: 0,
      passed: 0,
      stepsTotal: 0,
      stepsPassed: 0,
      usd: 0,
      tokensIn: 0,
      calls: 0,
      latencies: [],
      outcomes: [],
    };

    for (let i = 0; i < runs; i += 1) {
      const workDir = await mkdtemp(join(tmpdir(), "testsky-bench-"));
      try {
        const outcome = await runOnce({
          test,
          device,
          platform,
          workDir,
          video: false,
          // Cold by default: a benchmark measured through the cache measures
          // the cache, and the cache is already measured elsewhere.
          ...(useCache ? { memory: (attached: DeviceHandle) => openLock(path, test.id, platform, attached.size) } : {}),
        });
        score.runs += 1;
        score.outcomes.push(outcome.result.outcome);
        if (outcome.result.outcome === "PASS" || outcome.result.outcome === "HEALED_PASS") score.passed += 1;
        score.stepsTotal += outcome.result.steps.length;
        score.stepsPassed += outcome.result.steps.filter((step) => !step.outcome.startsWith("FAIL") && step.outcome !== "LOOP_DETECTED" && step.outcome !== "BUDGET_EXHAUSTED").length;
        score.usd += outcome.ledger.totalUsd();
        score.tokensIn += outcome.ledger.totalTokens().in;
        score.calls += outcome.ledger.all().length;
        score.latencies.push(...outcome.ledger.all().map((call) => call.latencyMs));
      } catch (error) {
        score.runs += 1;
        score.outcomes.push("DEVICE_ERROR");
        console.log(`  ${test.id}: ${(error as Error).message}`);
      }
    }

    scores.push(score);
    const rate = score.stepsTotal ? ((score.stepsPassed / score.stepsTotal) * 100).toFixed(0) : "0";
    console.log(
      `  ${score.test.padEnd(24)} ${rate.padStart(3)}% steps  ${String(score.passed)}/${score.runs} runs  ` +
        `${DIM}${(score.tokensIn / Math.max(1, score.runs) / 1000).toFixed(1)}k tok, p95 ${percentile(score.latencies, 0.95)}ms${RESET}`,
    );
  }

  const stepsTotal = scores.reduce((sum, score) => sum + score.stepsTotal, 0);
  const stepsPassed = scores.reduce((sum, score) => sum + score.stepsPassed, 0);
  const allLatencies = scores.flatMap((score) => score.latencies);
  const totalRuns = scores.reduce((sum, score) => sum + score.runs, 0);
  const summary = {
    at: new Date().toISOString(),
    platform,
    device: device.id,
    tests: scores.length,
    runs: totalRuns,
    stepSuccess: stepsTotal ? stepsPassed / stepsTotal : 0,
    runsPassed: scores.reduce((sum, score) => sum + score.passed, 0),
    usdPerTest: totalRuns ? scores.reduce((sum, score) => sum + score.usd, 0) / totalRuns : 0,
    tokensPerTest: totalRuns ? scores.reduce((sum, score) => sum + score.tokensIn, 0) / totalRuns : 0,
    callsPerTest: totalRuns ? scores.reduce((sum, score) => sum + score.calls, 0) / totalRuns : 0,
    latencyP50: percentile(allLatencies, 0.5),
    latencyP95: percentile(allLatencies, 0.95),
    byTest: scores.map(({ latencies, ...rest }) => ({ ...rest, latencyP95: percentile(latencies, 0.95) })),
  };

  await writeFile(outPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log("");
  console.log(
    `  ${(summary.stepSuccess * 100).toFixed(1)}% of steps, ${summary.runsPassed}/${summary.runs} runs, ` +
      `${(summary.tokensPerTest / 1000).toFixed(1)}k tokens/test, p50 ${summary.latencyP50}ms, p95 ${summary.latencyP95}ms`,
  );
  console.log(`  ${DIM}${outPath} — compare it with the last release before shipping a prompt change${RESET}\n`);
  return 0;
}
