/**
 * The commands that read and touch no phone: is this test file one testsky
 * can run, and how did that run go.
 *
 * Both exist for whoever writes tests without watching a terminal -- an
 * agent, a CI job: a test file checked before it costs a device and a model,
 * and a run read back from its folder instead of from the scrollback.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseTestFile, type TestFile } from "@testsky/artifact";
import { latestRun, readRun, type KeptRun } from "@testsky/harness";

import type { JsonAnswer } from "./json.ts";
import { exitCodeFor, ledgerOf, markdownReport, printReport, runAnswer } from "./report.ts";

const DIM = "\u001b[2m";
const GREEN = "\u001b[32m";
const RED = "\u001b[31m";
const RESET = "\u001b[0m";

/** A test file as testsky reads it, or why it cannot. */
export interface CheckedFile {
  path: string;
  ok: boolean;
  error?: string;
  test?: {
    id: string;
    title: string;
    targets: TestFile["targets"];
    setup: number;
    steps: { id: string; do?: string; expect?: string; extract?: Record<string, string> }[];
    teardown: number;
  };
}

/** Reads a test file the way a run would, and stops there: no device, no model. */
export function checkSource(source: string, path: string): CheckedFile {
  try {
    const test = parseTestFile(source, path);
    return {
      path,
      ok: true,
      test: {
        id: test.id,
        title: test.title,
        targets: test.targets,
        setup: test.setup.length,
        steps: test.steps.map((step) => ({
          id: step.id,
          ...(step.do ? { do: step.do } : {}),
          ...(step.expect ? { expect: step.expect } : {}),
          ...(step.extract ? { extract: step.extract } : {}),
        })),
        teardown: test.teardown.length,
      },
    };
  } catch (error) {
    return { path, ok: false, error: (error as Error).message };
  }
}

export async function checkFile(path: string): Promise<CheckedFile> {
  const full = resolve(path);
  const source = await readFile(full, "utf8").catch((error: NodeJS.ErrnoException) => {
    return error.code === "ENOENT" ? undefined : Promise.reject(error);
  });
  if (source === undefined) return { path: full, ok: false, error: `${full}: no such file` };
  return checkSource(source, full);
}

export async function commandValidate(argv: string[], json: JsonAnswer | undefined): Promise<number> {
  const paths = argv.filter((arg) => !arg.startsWith("--"));
  if (!paths.length) {
    console.error("testsky validate <test.testsky.yaml>... [--json]");
    return 2;
  }
  const files = await Promise.all(paths.map(checkFile));
  for (const file of files) {
    if (file.ok) {
      const test = file.test!;
      const platforms = [...new Set(test.targets.map((target) => target.platform))].join(", ");
      console.log(`  ${GREEN}ok${RESET}    ${file.path}  ${DIM}${test.id} · ${test.steps.length} step(s) · ${platforms}${RESET}`);
    } else {
      console.log(`  ${RED}fail${RESET}  ${file.error}`);
    }
  }
  const ok = files.every((file) => file.ok);
  json?.answer({ ok, exitCode: ok ? 0 : 2, files });
  return ok ? 0 : 2;
}

/** A kept run as `--json` answers it: the run's own answer once it has a result, and how far it got until then. */
export function keptAnswer(kept: KeptRun): Record<string, unknown> {
  const device = kept.meta.device as { id?: string; platform?: string } | undefined;
  const place = {
    platform: device?.platform ?? "",
    device: device?.id ?? "",
    dir: kept.dir,
    ...(kept.report ? { report: kept.report } : {}),
  };
  if (kept.result) return runAnswer(kept.result, ledgerOf(kept.result.calls), place);
  return {
    outcome: "NO_RESULT",
    exitCode: 2,
    detail: "no result yet: the run is still going, or it was stopped before its verdict",
    test: kept.meta.test,
    ...place,
    events: kept.events,
    ...(kept.lastStep ? { lastStep: kept.lastStep } : {}),
  };
}

export async function commandReport(argv: string[], json: JsonAnswer | undefined, flag: (argv: string[], name: string) => string | undefined): Promise<number> {
  const root = flag(argv, "out") ?? "runs";
  const given = argv.filter((arg, index) => !arg.startsWith("--") && argv[index - 1] !== "--out")[0];
  const dir = given ? resolve(given) : await latestRun(resolve(root));
  if (!dir) {
    console.error(`no run in ${resolve(root)}/: name a run's folder, or --out the folder runs were kept in`);
    return 2;
  }
  const kept = await readRun(dir);
  const code = kept.result ? exitCodeFor(kept.result) : 2;
  if (json) {
    json.answer(keptAnswer(kept));
    return code;
  }
  if (argv.includes("--md")) {
    process.stdout.write(markdownReport(kept));
    return code;
  }
  console.log(`${DIM}${String(kept.meta.title ?? kept.meta.test ?? "")}  ${dir}${RESET}`);
  if (!kept.result) {
    console.log(`\n  no result: the run is still going, or it was stopped before its verdict (${kept.events} event(s)${kept.lastStep ? `, last step ${kept.lastStep}` : ""})\n`);
    return code;
  }
  printReport(kept.result, ledgerOf(kept.result.calls));
  if (kept.report) console.log(`  ${DIM}${kept.report}${RESET}\n`);
  return code;
}
