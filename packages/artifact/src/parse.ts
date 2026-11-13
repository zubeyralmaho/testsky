/**
 * Reading a `.testsky.yaml`.
 *
 * Every error message names the step it came from and says what to write
 * instead. The people who will write these files are manual testers migrating
 * from a Jira test case, not engineers reading a stack trace -- if the parser
 * is rude to them, the import path we are selling does not work.
 */

import { parse as parseYaml } from "yaml";

import type { PopupAnswer, PopupKind, PopupRules } from "@testsky/engine-core";

import {
  DEFAULT_POLICY,
  POPUP_ANSWERS,
  POPUP_KINDS,
  type Directive,
  type TestFile,
  type TestPolicy,
  type TestStep,
  type TestTarget,
} from "./types.ts";

export class TestFileError extends Error {
  readonly where: string;
  constructor(where: string, message: string) {
    super(where ? `${where}: ${message}` : message);
    this.name = "TestFileError";
    this.where = where;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, where: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TestFileError(where, `\`${field}\` must be a non-empty string`);
  }
  return value.trim();
}

function num(value: unknown, fallback: number, where: string, field: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TestFileError(where, `\`${field}\` must be a positive number`);
  }
  return value;
}

/** A stable id derived from the step's own words, so inserting a step above
 *  does not renumber -- and therefore does not invalidate -- everything below. */
export function deriveStepId(text: string, taken: Set<string>): string {
  const base =
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .split("-")
      .filter(Boolean)
      .slice(0, 5)
      .join("-") || "step";
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

const LAUNCH = /^launch(?:\s+the)?\s+app(?:\s+(\S+))?$/i;
const TERMINATE = /^(?:terminate|close|kill)(?:\s+the)?\s+app(?:\s+(\S+))?$/i;
const FIXTURE = /^use\s+fixture:?\s+(\S+)$/i;

export function parseDirective(line: string, where: string): Directive {
  const text = str(line, where, "directive");
  const launch = LAUNCH.exec(text);
  if (launch) return launch[1] ? { kind: "launch", app: launch[1] } : { kind: "launch" };
  const terminate = TERMINATE.exec(text);
  if (terminate) return terminate[1] ? { kind: "terminate", app: terminate[1] } : { kind: "terminate" };
  const fixture = FIXTURE.exec(text);
  if (fixture?.[1]) return { kind: "fixture", name: fixture[1] };
  // Anything else is an instruction for the agent, same as a step's `do`.
  return { kind: "do", text };
}

function parseTargets(raw: unknown, where: string): TestTarget[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new TestFileError(where, "`targets` must list at least one { platform, app }");
  }
  return raw.map((entry, i) => {
    const at = `${where}.targets[${i}]`;
    if (!isRecord(entry)) throw new TestFileError(at, "expected { platform, app }");
    const platform = str(entry.platform, at, "platform");
    if (platform !== "android" && platform !== "ios" && platform !== "web") {
      throw new TestFileError(at, "`platform` must be android, ios or web");
    }
    return { platform, app: str(entry.app, at, "app") };
  });
}

/**
 * The words people reach for, mapped to the four answers. A tester copying a
 * rule off the prompt writes "reject", not "deny", and a parser that refuses
 * the obvious word teaches them the file format is the hard part.
 */
const POPUP_WORDS: Record<string, PopupAnswer> = {
  allow: "allow",
  accept: "allow",
  deny: "deny",
  decline: "deny",
  reject: "deny",
  dismiss: "dismiss",
  close: "dismiss",
  off: "off",
};

function parsePopups(raw: unknown, where: string): Partial<PopupRules> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    throw new TestFileError(where, "`policy.popups` must map a kind of pop-up to an answer, e.g. `notifications: allow`");
  }
  const rules: Partial<PopupRules> = {};
  for (const [name, value] of Object.entries(raw)) {
    const kind = name as PopupKind;
    if (!POPUP_KINDS.includes(kind)) {
      throw new TestFileError(where, `\`policy.popups.${name}\` is not a kind of pop-up -- use one of ${POPUP_KINDS.join(", ")}`);
    }
    // `false` is what YAML 1.1 made of a bare `off`, and some editors still write it.
    const word = value === false ? "off" : typeof value === "string" ? value.trim().toLowerCase() : "";
    const answer = POPUP_WORDS[word];
    if (!answer || !POPUP_ANSWERS[kind].includes(answer)) {
      const allowed = POPUP_ANSWERS[kind];
      const why = allowed.includes("allow") ? "" : " -- a sheet is closed, not allowed or denied";
      throw new TestFileError(
        where,
        `\`policy.popups.${name}\` must be ${allowed.slice(0, -1).join(", ")} or ${allowed[allowed.length - 1]}${why}`,
      );
    }
    rules[kind] = answer;
  }
  return rules;
}

function parsePolicy(raw: unknown, where: string): TestPolicy {
  if (raw === undefined) return DEFAULT_POLICY;
  if (!isRecord(raw)) throw new TestFileError(where, "`policy` must be a mapping");
  const budgetRaw = isRecord(raw.budget) ? raw.budget : {};
  const runs = num(raw.runs, DEFAULT_POLICY.runs, where, "policy.runs");
  const passThreshold = num(
    raw.pass_threshold,
    Math.min(DEFAULT_POLICY.passThreshold, runs),
    where,
    "policy.pass_threshold",
  );
  if (passThreshold > runs) {
    throw new TestFileError(where, "`policy.pass_threshold` cannot exceed `policy.runs`");
  }
  const popups = parsePopups(raw.popups, where);
  return {
    runs,
    passThreshold,
    budget: {
      maxSteps: num(budgetRaw.max_steps, DEFAULT_POLICY.budget.maxSteps, where, "policy.budget.max_steps"),
      maxUsd: num(budgetRaw.max_usd, DEFAULT_POLICY.budget.maxUsd, where, "policy.budget.max_usd"),
      maxSeconds: num(budgetRaw.max_seconds, DEFAULT_POLICY.budget.maxSeconds, where, "policy.budget.max_seconds"),
    },
    ...(popups ? { popups } : {}),
  };
}

function parseSteps(raw: unknown, where: string): TestStep[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new TestFileError(where, "`steps` must list at least one step");
  }
  const taken = new Set<string>();
  return raw.map((entry, i) => {
    const at = `${where}.steps[${i}]`;
    if (!isRecord(entry)) throw new TestFileError(at, "expected a mapping with `do` and/or `expect`");
    const doText = entry.do === undefined ? undefined : str(entry.do, at, "do");
    const expectText = entry.expect === undefined ? undefined : str(entry.expect, at, "expect");
    const extractRaw = entry.extract;
    if (!doText && !expectText && entry.wait === undefined && entry.answer === undefined) {
      throw new TestFileError(at, "a step needs `do` (an action) or `expect` (a check), or both, or a `wait`, or an `answer`");
    }

    let extract: Record<string, string> | undefined;
    if (extractRaw !== undefined) {
      if (!isRecord(extractRaw)) throw new TestFileError(at, "`extract` must map field names to descriptions");
      extract = {};
      for (const [field, description] of Object.entries(extractRaw)) {
        extract[field] = str(description, at, `extract.${field}`);
      }
    }

    let channel: "vision" | "tree" | undefined;
    if (entry.channel !== undefined) {
      const raw = str(entry.channel, at, "channel");
      if (raw !== "vision" && raw !== "tree") {
        throw new TestFileError(at, "`channel` must be vision or tree");
      }
      channel = raw;
    }

    // Said out loud: left to be ignored, it would show what its author took to be hidden.
    if (entry.secret !== undefined) throw new TestFileError(at, "a step cannot be `secret`: a report shows everything a run does");

    let within: number | undefined;
    if (entry.within !== undefined) {
      if (!expectText) throw new TestFileError(at, "`within` is how long an expectation may take to hold: this step has no `expect`");
      within = parseWithin(entry.within, at);
    }

    let wait: number | undefined;
    if (entry.wait !== undefined) {
      if (doText) throw new TestFileError(at, "`wait` lets time pass before a check: an action goes in a step of its own");
      wait = parseWithin(entry.wait, at, "wait");
    }

    let answer: "call" | undefined;
    let ring: number | undefined;
    if (entry.answer !== undefined) {
      if (entry.answer !== "call") throw new TestFileError(at, "`answer` answers an incoming call: write `answer: call`");
      if (doText) throw new TestFileError(at, "`answer` waits for a call and answers it: an action goes in a step of its own");
      if (wait !== undefined) throw new TestFileError(at, "`answer` and `wait` both let time pass: use one of them");
      if (entry.ring === undefined) throw new TestFileError(at, "`answer: call` needs `ring`: how long the call may take to come, such as \"240s\"");
      answer = "call";
      ring = parseWithin(entry.ring, at, "ring");
    } else if (entry.ring !== undefined) {
      throw new TestFileError(at, "`ring` is how long a call may take to come: it goes with `answer: call`");
    }

    const explicitId = entry.id === undefined ? undefined : str(entry.id, at, "id");
    const id = explicitId ?? deriveStepId(doText ?? expectText ?? (answer ? "answer call" : "wait"), taken);
    if (taken.has(id)) throw new TestFileError(at, `duplicate step id "${id}"`);
    taken.add(id);

    const step: TestStep = { id, idGenerated: explicitId === undefined };
    if (doText) step.do = doText;
    if (expectText) step.expect = expectText;
    if (within !== undefined) step.within = within;
    if (wait !== undefined) step.wait = wait;
    if (answer) step.answer = answer;
    if (ring !== undefined) step.ring = ring;
    if (extract) step.extract = extract;
    if (channel) step.channel = channel;
    return step;
  });
}

function parseDirectives(raw: unknown, where: string): Directive[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new TestFileError(where, "expected a list of lines");
  return raw.map((line, i) => parseDirective(line as string, `${where}[${i}]`));
}

/**
 * A wait, as a person writes it -- "45s", "2m", "1m30s", or a number of
 * seconds -- in milliseconds.
 */
export function parseWithin(raw: unknown, at: string, field = "within"): number {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim().toLowerCase() : "";
  const plain = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : undefined;
  const spelled = /^(?:(\d+)\s*m(?:in)?)?\s*(?:(\d+)\s*s(?:ec)?)?$/.exec(text);
  const seconds = plain ?? (spelled && (spelled[1] || spelled[2]) ? Number(spelled[1] ?? 0) * 60 + Number(spelled[2] ?? 0) : undefined);
  if (seconds === undefined || !(seconds >= 1)) {
    throw new TestFileError(at, `\`${field}\` is a wait of a second or more, such as "45s", "2m" or "1m30s"`);
  }
  return Math.round(seconds * 1000);
}

export function parseTestFile(source: string, path?: string): TestFile {
  let doc: unknown;
  try {
    doc = parseYaml(source);
  } catch (error) {
    throw new TestFileError(path ?? "", `not valid YAML -- ${(error as Error).message}`);
  }
  const where = path ?? "test";
  if (!isRecord(doc)) throw new TestFileError(where, "expected a mapping at the top level");

  const id = str(doc.id, where, "id");
  const file: TestFile = {
    id,
    title: typeof doc.title === "string" && doc.title.trim() ? doc.title.trim() : id,
    targets: parseTargets(doc.targets, where),
    policy: parsePolicy(doc.policy, where),
    setup: parseDirectives(doc.setup, `${where}.setup`),
    steps: parseSteps(doc.steps, where),
    teardown: parseDirectives(doc.teardown, `${where}.teardown`),
  };
  // A wait the test's own time cannot hold would end the test before the
  // wait did, and call that the budget.
  for (const step of file.steps) {
    if (step.within !== undefined && step.within >= file.policy.budget.maxSeconds * 1000) {
      throw new TestFileError(
        `${where}.steps.${step.id}`,
        `\`within\` waits ${step.within / 1000} s, which leaves the test's max_seconds (${file.policy.budget.maxSeconds}) no time for anything else`,
      );
    }
    if (step.ring !== undefined && step.ring >= file.policy.budget.maxSeconds * 1000) {
      throw new TestFileError(
        `${where}.steps.${step.id}`,
        `\`ring\` waits ${step.ring / 1000} s, which leaves the test's max_seconds (${file.policy.budget.maxSeconds}) no time for anything else`,
      );
    }
  }
  if (path) file.path = path;
  return file;
}
