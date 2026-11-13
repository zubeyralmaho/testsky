/**
 * Writing to a test file the way a person would: steps added at the end,
 * and everything already there -- comments, order, wording, ids -- left as
 * it was written.
 */

import { Document, isMap, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from "yaml";

import { deriveStepId, parseTestFile, TestFileError } from "./parse.ts";
import type { TestStep, TestTarget } from "./types.ts";

/** A step as it is written: what to do, what must hold, what to read. */
export type StepText = Pick<TestStep, "do" | "expect" | "extract">;

export interface AppendedSteps {
  source: string;
  /** The ids the new steps were given, in order. */
  ids: string[];
}

const BEGUN =
  " Begun in the testsky playground: each step is an instruction as it was given there.\n" +
  " The run launches the app first, so the first step starts from the app's first screen.";

function begin(test: { id: string; title: string; target: TestTarget }): Document {
  const doc = new Document({
    id: test.id,
    title: test.title,
    targets: [{ platform: test.target.platform, app: test.target.app }],
    setup: ["launch app"],
    steps: [],
    teardown: ["terminate app"],
  });
  doc.commentBefore = BEGUN;
  return doc;
}

/**
 * The file with `steps` added at its end. A file not there yet (`source`
 * undefined) is begun for `test`: launching its app before the steps and
 * closing it after. A file that does not name `test.target`'s platform gets
 * that target. Ids are derived from the steps' own words, as the parser
 * derives them, never one already taken. The result is read back before it
 * is returned: a file this would break is refused, and nothing is written.
 */
export function appendSteps(
  source: string | undefined,
  steps: StepText[],
  test: { id: string; title: string; target: TestTarget },
  path?: string,
): AppendedSteps {
  const where = path ?? test.id;
  if (!steps.length) throw new TestFileError(where, "there is no step to add");
  for (const step of steps) {
    if (!step.do && !step.expect) throw new TestFileError(where, "a step needs `do` (an action) or `expect` (a check)");
  }

  const doc = source === undefined ? begin(test) : parseDocument(source);
  if (doc.errors.length) throw new TestFileError(where, `not valid YAML -- ${doc.errors[0]!.message}`);
  const taken = new Set(source === undefined ? [] : parseTestFile(source, path).steps.map((step) => step.id));

  const targets = doc.get("targets", true);
  if (!isSeq(targets)) throw new TestFileError(where, "`targets` must be a list");
  const named = targets.items.some((item) => isMap(item) && item.get("platform") === test.target.platform);
  if (!named) {
    const target = doc.createNode({ platform: test.target.platform, app: test.target.app }) as YAMLMap;
    target.flow = true;
    targets.add(target);
  }
  for (const item of targets.items) if (isMap(item) && source === undefined) item.flow = true;

  const list = doc.get("steps", true) as YAMLSeq | undefined;
  if (!isSeq(list)) throw new TestFileError(where, "`steps` must be a list");
  list.flow = false;
  // A blank line between steps where the file has them, and none where it has none.
  const spaced = list.items.some((item, index) => index > 0 && (item as { spaceBefore?: boolean }).spaceBefore);

  const ids: string[] = [];
  for (const step of steps) {
    const id = deriveStepId(step.do ?? step.expect ?? "step", taken);
    taken.add(id);
    ids.push(id);
    const node = doc.createNode({
      id,
      ...(step.do ? { do: step.do } : {}),
      ...(step.expect ? { expect: step.expect } : {}),
      ...(step.extract ? { extract: step.extract } : {}),
    }) as YAMLMap;
    if (spaced && list.items.length) node.spaceBefore = true;
    list.add(node);
  }

  const written = doc.toString({ lineWidth: 0 });
  parseTestFile(written, path);
  return { source: written, ids };
}
