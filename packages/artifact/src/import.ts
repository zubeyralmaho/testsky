/**
 * The hundreds of test cases a QA team already owns.
 *
 * This is the easiest sale in the product and the hardest thing to do
 * honestly. Easy, because every enterprise QA team has a Jira/Xray or TestRail
 * export full of manual cases nobody has time to automate, and "run the ones
 * you already wrote" needs no new process. Hard, because a manual case is
 * written for a person who knows the app: "Login" as a step, "works" as an
 * expected result.
 *
 * So this is a **draft generator, not a migration**. It converts what is
 * mechanical -- the step text, the data, the expected result, the grouping by
 * case -- and leaves everything it could only have guessed for a person to
 * fix. Every generated file says so at the top, and nothing generated is run
 * without somebody having opened it.
 */

import type { Platform } from "@testsky/engine-core";

import type { TestFile, TestStep } from "./types.ts";
import { deriveStepId } from "./parse.ts";
import { DEFAULT_POLICY } from "./types.ts";

/** A row as an exporter wrote it: whatever it called its columns. */
export type CsvRow = Record<string, string>;

/**
 * A small CSV reader. Quoted fields, doubled quotes, newlines inside quotes --
 * which is the whole of what a Jira export produces, and more than a `split`
 * can survive.
 */
export function parseCsv(text: string): CsvRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") field += char;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  const header = rows.shift();
  if (!header) return [];
  return rows
    .filter((cells) => cells.some((cell) => cell.trim()))
    .map((cells) => {
      const record: CsvRow = {};
      header.forEach((name, index) => {
        record[name.trim().toLowerCase()] = (cells[index] ?? "").trim();
      });
      return record;
    });
}

/** What the exporters call things. Xray first, TestRail second, then the rest. */
const COLUMNS = {
  key: ["key", "issue key", "id", "case id", "test case id"],
  title: ["summary", "title", "name", "test case"],
  action: ["action", "step", "steps", "test step", "step description", "step actions"],
  data: ["data", "test data", "step data"],
  expected: ["expected result", "expected", "result", "expected results"],
  index: ["step index", "index", "order", "#"],
};

function pick(row: CsvRow, names: string[]): string {
  for (const name of names) {
    const value = row[name];
    if (value) return value;
  }
  return "";
}

export interface ImportOptions {
  platform: Platform;
  app: string;
  /** Rows without a case key are all one test, named this. */
  fallbackId?: string;
}

export interface ImportedTest {
  file: TestFile;
  /** What a person has to look at before this is worth running. */
  warnings: string[];
}

/**
 * One draft per case.
 *
 * The conversions that are safe: a step's action becomes `do`, its expected
 * result becomes `expect`, its data is appended to the action rather than
 * invented into a field. The ones that are not: a step with no expected result
 * gets none -- a checked expectation is what makes a test a test, and making
 * one up would be worse than leaving the gap visible.
 */
export function importTestCases(rows: CsvRow[], options: ImportOptions): ImportedTest[] {
  const byCase = new Map<string, CsvRow[]>();
  for (const row of rows) {
    const key = pick(row, COLUMNS.key) || options.fallbackId || "imported";
    const list = byCase.get(key) ?? [];
    list.push(row);
    byCase.set(key, list);
  }

  const drafts: ImportedTest[] = [];
  for (const [key, caseRows] of byCase) {
    const warnings: string[] = [];
    const title = pick(caseRows[0]!, COLUMNS.title) || key;
    const taken = new Set<string>();
    const steps: TestStep[] = [];

    for (const row of caseRows) {
      const action = pick(row, COLUMNS.action);
      const data = pick(row, COLUMNS.data);
      const expected = pick(row, COLUMNS.expected);
      if (!action && !expected) continue;

      const doText = [action, data && `(${data})`].filter(Boolean).join(" ").trim();
      const step: TestStep = {
        id: deriveStepId(doText || expected, taken),
        idGenerated: true,
      };
      taken.add(step.id);
      if (doText) step.do = doText;
      if (expected) step.expect = expected;
      else if (doText) warnings.push(`step "${step.id}" has no expected result -- it does something and checks nothing`);

      // A manual case says "Login"; an agent needs to know what that looks
      // like when it worked. Flagging is honest; guessing is not.
      if (doText && doText.split(/\s+/).length <= 2) {
        warnings.push(`step "${step.id}" is two words ("${doText}") -- an agent will have to guess what it means`);
      }
      if (expected && /^(works|ok|success(ful)?|pass(es)?|as expected)\.?$/i.test(expected.trim())) {
        warnings.push(`step "${step.id}" expects "${expected}", which cannot fail -- rewrite it as something visible`);
      }
      steps.push(step);
    }

    if (!steps.length) continue;
    drafts.push({
      file: {
        id: key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
        title,
        targets: [{ platform: options.platform, app: options.app }],
        policy: DEFAULT_POLICY,
        setup: [{ kind: "launch" }],
        steps,
        teardown: [{ kind: "terminate" }],
      },
      warnings,
    });
  }
  return drafts;
}

/** The draft, as a file -- with its provenance and its doubts at the top. */
export function serializeDraft(draft: ImportedTest, source: string): string {
  const { file } = draft;
  const lines: string[] = [
    `# Drafted by \`testsky import\` from ${source}. NOT a migration: read it before you run it.`,
    "#",
    "# A manual case is written for someone who knows the app -- \"Login\", \"works\" --",
    "# and an agent knows nothing. What could be converted mechanically was; what",
    "# would have had to be guessed was left alone.",
  ];
  if (draft.warnings.length) {
    lines.push("#", "# Before this is worth running:");
    for (const warning of draft.warnings) lines.push(`#   - ${warning}`);
  }
  lines.push(
    "",
    `id: ${file.id}`,
    `title: ${JSON.stringify(file.title)}`,
    "targets:",
    ...file.targets.map((target) => `  - { platform: ${target.platform}, app: ${target.app} }`),
    "setup:",
    "  - launch app",
    "steps:",
  );
  for (const step of file.steps) {
    lines.push(`  - id: ${step.id}`);
    if (step.do) lines.push(`    do: ${JSON.stringify(step.do)}`);
    if (step.expect) lines.push(`    expect: ${JSON.stringify(step.expect)}`);
    lines.push("");
  }
  lines.push("teardown:", "  - terminate app", "");
  return lines.join("\n");
}

/** The other direction: a test as something to paste back into Jira. */
export function exportMarkdown(file: TestFile): string {
  const lines = [`# ${file.title}`, "", `Runs on: ${file.targets.map((t) => `${t.platform} (${t.app})`).join(", ")}`, ""];
  lines.push("| # | Action | Expected result |", "|---|---|---|");
  file.steps.forEach((step, index) => {
    const wait = step.within ? ` (within ${step.within / 1000} s)` : "";
    lines.push(`| ${index + 1} | ${step.do ?? ""} | ${step.expect ? `${step.expect}${wait}` : ""} |`);
  });
  lines.push("", `_Exported from ${file.id}.testsky.yaml — the file, not this table, is what runs._`);
  return lines.join("\n");
}
