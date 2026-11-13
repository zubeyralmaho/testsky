/**
 * One file you can send someone.
 *
 * The complaint about every tool in this category is the same: the evidence is
 * there, and it is unusable -- a failure buried somewhere in an unindexed
 * video, logs in another tab, the cost nowhere. So this is not a video player
 * with a list beside it. It is a timeline: every step knows when it happened
 * relative to frame zero, clicking one seeks the video to that instant, and
 * the events of that moment are what is shown beside it.
 *
 * Everything is inlined -- video, screenshots, styles, script -- because the
 * artefact has to survive being attached to an email.
 */

import type { Outcome, StepResult, TestResult, RunEvent } from "@testsky/executor";
import type { LedgerEntry } from "@testsky/router";

export interface ReportInput {
  result: TestResult;
  events: RunEvent[];
  calls: readonly LedgerEntry[];
  meta: {
    test: string;
    title: string;
    platform: string;
    device: string;
    engine: string;
    appBuild?: string;
    pullRequest?: boolean;
    /** The runner's own version, for the viewer's header. */
    version?: string;
  };
  /** Frame zero, on the same clock as every event. */
  videoStartedAt?: number;
  /** The recording, already base64'd, or absent when there is none. */
  videoBase64?: string;
  videoMime?: string;
  /** Screenshots, base64: each step's verdict frame by step id, each pop-up's by its own shot id. */
  shots?: Record<string, string>;
  /** The app's own device log, on the same clock, oldest first; `dropped` earlier lines did not fit. */
  deviceLog?: { lines: { at: number; text: string }[]; dropped?: number };
}

const escape = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// Keyed by the taxonomy itself, so an outcome added without a colour and a
// sentence is a type error rather than a grey badge nobody can read.
const OUTCOME_CLASS: Record<Outcome, string> = {
  PASS: "ok",
  HEALED_PASS: "healed",
  FAIL_ASSERT: "bad",
  FAIL_REJECTED_HEAL: "bad",
  FAIL_GROUND: "warn",
  BUDGET_EXHAUSTED: "warn",
  LOOP_DETECTED: "warn",
  DEVICE_ERROR: "grey",
  VACUOUS_ASSERT: "warn",
  RUNNER_LOST: "grey",
};

const VERDICT: Record<Outcome, string> = {
  PASS: "Passed",
  HEALED_PASS: "Passed, but a step had to be re-resolved — review the heal",
  FAIL_ASSERT: "An expectation was checked and was false: your app may be broken",
  FAIL_REJECTED_HEAL: "A change a person already rejected happened again: your app may be broken",
  FAIL_GROUND: "The test could not find an element it was told to act on",
  BUDGET_EXHAUSTED: "The agent ran out of budget before finishing",
  LOOP_DETECTED: "The agent got stuck repeating itself",
  DEVICE_ERROR: "The device or its tooling failed",
  VACUOUS_ASSERT: "An expectation could never have failed — rewrite it",
  RUNNER_LOST: "The runner stopped reporting before the run finished — this says nothing about the app",
};

/**
 * A pull request's heal is not put up for review -- its runner leaves the
 * memory as it was -- so its report must not send anybody looking for one.
 */
export function verdictFor(outcome: Outcome, pullRequest: boolean): string {
  if (pullRequest && outcome === "HEALED_PASS") {
    return "Passed, but a step had to be re-resolved — on a pull request, so the memory is unchanged, and the change is reviewed once it reaches the mainline";
  }
  return VERDICT[outcome] ?? outcome;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The pop-ups a step answered, each beside the screen it was answered on.
 *
 * Shown rather than summarised, because a rule answered something on
 * somebody's behalf, and the only way to be sure it answered the right thing
 * is to look at what was there.
 */
function popupList(events: RunEvent[], shots: Record<string, string> | undefined): string {
  const answered = events.filter((event) => event.kind === "popup");
  if (!answered.length) return "";
  return `<ul class="popups">${answered
    .map((event) => {
      const shot = event.shotId ? shots?.[event.shotId] : undefined;
      return `<li>${shot ? `<img loading="lazy" src="data:image/webp;base64,${shot}" alt="the pop-up, as it was answered">` : ""}<span>${escape(
        event.message,
      )}<span class="muted"> · ${event.data?.by === "tree" ? "read from the screen's tree" : "seen by the model"}</span></span></li>`;
    })
    .join("")}</ul>`;
}

const SHOWN: Record<string, string> = { vision: "screenshot", tree: "tree only", fused: "screenshot + tree" };

const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

function pointOf(value: unknown): { x: number; y: number } | undefined {
  const point = value as { x?: unknown; y?: unknown } | null | undefined;
  const x = num(point?.x);
  const y = num(point?.y);
  return x === undefined || y === undefined ? undefined : { x, y };
}

function sizeOf(value: unknown): { width: number; height: number } | undefined {
  const size = value as { width?: unknown; height?: unknown } | null | undefined;
  const width = num(size?.width);
  const height = num(size?.height);
  return width && height ? { width, height } : undefined;
}

function rectOf(value: unknown): { x: number; y: number; width: number; height: number } | undefined {
  const rect = value as { width?: unknown; height?: unknown } | null | undefined;
  const corner = pointOf(rect);
  const size = sizeOf(rect);
  return corner && size ? { ...corner, ...size } : undefined;
}

/** A share of the screen, as CSS, clamped so a point off the edge still shows at the edge. */
const pct = (part: number, whole: number): string => `${Math.min(100, Math.max(0, (part / whole) * 100)).toFixed(2)}%`;

/** Who found the target: memory of an earlier run, the model and the tree agreeing, one of them alone, and what a model was shown. */
function sourceOf(data: Record<string, unknown>): { label: string; tone: string } {
  if (data.by === "memory" || data.cached === true) {
    const checked = data.checkedBy === "tree" ? ", checked against the tree" : data.checkedBy === "pixels" ? ", checked against the pixels" : "";
    return { label: `from memory${checked}`, tone: "memory" };
  }
  if (data.by === "both") return { label: "model and tree agreeing", tone: "tree" };
  if (data.by === "tree") return { label: "tree alone, the model found nothing", tone: "tree" };
  if (data.by === "model") {
    const seen = typeof data.seen === "string" ? SHOWN[data.seen] : undefined;
    return { label: seen ? `model · ${seen}` : "model", tone: data.seen === "fused" || data.seen === "tree" ? "tree" : "model" };
  }
  return { label: "", tone: "" };
}

/**
 * Each action on the screen it was decided on, with the point it pressed and
 * the box the model drew, and who found the target. That last part is the
 * one a reviewer cannot get from the video: a tap from memory costs nothing
 * and a model's answer is only as good as what it was shown.
 */
function actionList(events: RunEvent[], shots: Record<string, string> | undefined, at: (epoch: number) => number): string {
  const acted = events.filter((event) => event.kind === "action");
  if (!acted.length) return "";
  return `<ol class="actions">${acted
    .map((event) => {
      const data = event.data ?? {};
      const shot = event.shotId ? shots?.[event.shotId] : undefined;
      const screen = sizeOf(data.screen);
      const target = pointOf(data.target);
      const box = rectOf(data.box);
      const marks =
        screen && box
          ? `<span class="box" style="left:${pct(box.x, screen.width)};top:${pct(box.y, screen.height)};width:${pct(box.width, screen.width)};height:${pct(box.height, screen.height)}"></span>`
          : "";
      const mark = screen && target ? `<span class="mark" style="left:${pct(target.x, screen.width)};top:${pct(target.y, screen.height)}"></span>` : "";
      const source = sourceOf(data);
      const confidence = num(data.confidence);
      const facts = [
        confidence !== undefined ? `confidence ${confidence.toFixed(2)}` : "",
        data.moved === false ? "the screen did not change" : data.moved === true ? "the screen changed" : "",
      ].filter(Boolean);
      return `<li data-at="${at(event.at).toFixed(2)}"${data.moved === false ? ' class="still"' : ""}>${
        shot ? `<figure class="frame"><img loading="lazy" src="data:image/webp;base64,${shot}" alt="the screen this was decided on">${marks}${mark}</figure>` : ""
      }<div class="what"><strong>${escape(event.message)}</strong>${
        source.label ? ` <span class="by ${source.tone}">${escape(source.label)}</span>` : ""
      }${facts.length ? `<span class="muted">${escape(facts.join(" · "))}</span>` : ""}${
        typeof data.why === "string" ? `<p class="why">${escape(data.why)}</p>` : ""
      }${typeof data.thought === "string" ? `<p class="why"><span class="muted">planner:</span> ${escape(data.thought)}</p>` : ""}${
        typeof data.tree === "string" ? `<details class="tree"><summary>the tree it was shown</summary><pre>${escape(data.tree)}</pre></details>` : ""
      }</div></li>`;
    })
    .join("")}</ol>`;
}

/** JSON laid out to be read: an object a key a line, a list of plain values on one line. */
function layJson(value: unknown, indent = ""): string {
  if (Array.isArray(value)) {
    if (value.every((each) => each === null || typeof each !== "object")) return `[${value.map((each) => JSON.stringify(each)).join(", ")}]`;
    const inner = `${indent}  `;
    return `[\n${value.map((each) => `${inner}${layJson(each, inner)}`).join(",\n")}\n${indent}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) return "{}";
    const inner = `${indent}  `;
    return `{\n${entries.map(([key, each]) => `${inner}${JSON.stringify(key)}: ${layJson(each, inner)}`).join(",\n")}\n${indent}}`;
  }
  return JSON.stringify(value);
}

/** An answer as it reads best: its JSON laid out, any words around it kept; else as it came. */
export function prettyAnswer(answer: string): string {
  const text = answer.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, "");
  const unfenced = text.replace(/```(?:json)?/gi, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start) return text;
  try {
    const laid = layJson(JSON.parse(unfenced.slice(start, end + 1)));
    const around = `${unfenced.slice(0, start)}${unfenced.slice(end + 1)}`.trim();
    return around ? `${around}\n\n${laid}` : laid;
  } catch {
    return text;
  }
}

/**
 * A call's conversation, folded under its row: the picture it was shown, its
 * instructions, its question with the tree lines apart, what it thought and
 * what it answered. Nothing at all for a call that kept none of it.
 */
function conversation(call: LedgerEntry, shots: Record<string, string> | undefined): string {
  const asked = call.asked;
  if (!asked && call.answer === undefined && !call.reasoning) return "";
  const span = asked?.treeSpan && asked.treeSpan[1] <= asked.user.length ? asked.treeSpan : undefined;
  const before = asked ? (span ? asked.user.slice(0, span[0]).replace(/\n+$/, "") : asked.user) : "";
  const tree = asked && span ? asked.user.slice(span[0], span[1]) : "";
  const after = asked && span ? asked.user.slice(span[1]).replace(/^\n+/, "") : "";
  const picture = asked?.image ? shots?.[asked.image] : undefined;
  return `<tr class="conv"><td colspan="8"><details><summary>asked · thought · answered</summary><div class="conv-body">${
    picture ? `<img class="seen" loading="lazy" src="data:image/webp;base64,${picture}" alt="the picture it was shown">` : ""
  }<div class="conv-words">${
    asked
      ? `<details class="tree"><summary>instructions</summary><pre>${escape(asked.system)}</pre></details>` +
        (before ? `<pre>${escape(before)}</pre>` : "") +
        (tree ? `<details class="tree"><summary>accessibility tree · ${tree.split("\n").length} lines</summary><pre>${escape(tree)}</pre></details>` : "") +
        (after ? `<pre>${escape(after)}</pre>` : "")
      : `<p class="muted">the question was not kept</p>`
  }<p class="label">thought</p>${
    call.reasoning ? `<pre>${escape(call.reasoning)}</pre>` : `<p class="muted">its host sent no thinking back</p>`
  }<p class="label">answered</p>${
    call.answer === undefined ? `<p class="muted">not kept</p>` : `<pre>${escape(prettyAnswer(call.answer))}</pre>`
  }</div></div></details></td></tr>`;
}

export function buildReport(input: ReportInput): string {
  const { result, events, calls, meta } = input;
  // Frame zero if there is a video, the run's own start if there is not.
  const zero = input.videoStartedAt ?? result.startedAt;
  const at = (epoch: number) => Math.max(0, (epoch - zero) / 1000);

  // Each line of the app's log goes under the step that was running when it
  // was written -- the last one started by then -- and the ones from before
  // the first step, when the app was opened, go above them all.
  const logs = new Map<number, { at: number; text: string }[]>();
  for (const line of input.deviceLog?.lines ?? []) {
    let step = -1;
    result.steps.forEach((candidate, index) => {
      if (candidate.startedAt <= line.at) step = index;
    });
    logs.set(step, [...(logs.get(step) ?? []), line]);
  }
  const logList = (lines: { at: number; text: string }[] | undefined): string =>
    lines?.length
      ? `<details class="device-log"><summary>${lines.length} line${lines.length === 1 ? "" : "s"} from the app's log</summary><ol class="log">${lines
          .map(
            (line) =>
              `<li data-at="${at(line.at).toFixed(2)}"${/^(error|fault): |^[EFA] /.test(line.text) ? ' class="serious"' : ""}><span class="t">${at(
                line.at,
              ).toFixed(1)}s</span> ${escape(line.text)}</li>`,
          )
          .join("")}</ol></details>`
      : "";
  const dropped = input.deviceLog?.dropped ?? 0;
  const beforeSteps =
    logs.has(-1) || dropped
      ? `<div class="panel"><strong>Before the first step</strong>${
          dropped ? `<p class="muted">${dropped} earlier line${dropped === 1 ? "" : "s"} of the app's log did not fit, and were left out.</p>` : ""
        }${logList(logs.get(-1))}</div>`
      : "";

  const steps = result.steps.map((step: StepResult) => ({
    ...step,
    offset: at(step.startedAt),
    endOffset: at(step.finishedAt),
    events: events.filter((event) => event.stepId === step.stepId),
  }));

  const total = result.finishedAt - result.startedAt;
  const usd = calls.reduce((sum, call) => sum + call.usd, 0);
  const tokensIn = calls.reduce((sum, call) => sum + (call.tokensIn ?? 0), 0);
  const acted = events.filter((event) => event.kind === "action").map((event) => event.data ?? {});
  const remembered = acted.filter((data) => data.by === "memory" || data.cached === true).length;
  const agreed = acted.filter((data) => data.by === "both").length;
  const treeAlone = acted.filter((data) => data.by === "tree").length;
  const byModel = acted.filter((data) => data.by === "model");
  const withTree = byModel.filter((data) => data.seen === "fused" || data.seen === "tree").length;
  const found = [
    `${remembered} from memory`,
    agreed ? `${agreed} model and tree agreeing` : "",
    byModel.length || !(agreed || treeAlone) ? `${byModel.length} by a model${withTree ? ` (${withTree} with the tree)` : ""}` : "",
    treeAlone ? `${treeAlone} by the tree alone` : "",
  ].filter(Boolean);
  const actionSummary = acted.length ? ` · ${acted.length} action${acted.length === 1 ? "" : "s"}: ${found.join(", ")}` : "";
  const byTier = calls.reduce<Record<number, number>>((acc, call) => {
    acc[call.tier] = (acc[call.tier] ?? 0) + 1;
    return acc;
  }, {});

  const stepRail = steps
    .map(
      (step, index) => `
      <button class="rail-step ${OUTCOME_CLASS[step.outcome] ?? "grey"}" data-seek="${step.offset.toFixed(2)}" data-step="${index}"
        style="flex: ${Math.max(1, step.endOffset - step.offset).toFixed(2)}">
        <span>${escape(step.stepId)}</span>
      </button>`,
    )
    .join("");

  const stepCards = steps
    .map(
      (step, index) => `
      <section class="step ${OUTCOME_CLASS[step.outcome] ?? "grey"}" id="step-${index}" data-seek="${step.offset.toFixed(2)}">
        <header>
          <span class="badge">${escape(step.outcome)}</span>
          <h3>${escape(step.stepId)}</h3>
          <span class="muted">${seconds(step.finishedAt - step.startedAt)} · ${step.actions} action(s)${
            step.fromCache ? " · remembered" : ""
          }${step.healed ? " · healed" : ""}${
            step.popups ? ` · ${step.popups} pop-up${step.popups === 1 ? "" : "s"} answered` : ""
          }${step.usd > 0 ? ` · $${step.usd.toFixed(4)}` : ""}</span>
        </header>
        <p class="detail">${escape(step.detail)}</p>
        ${popupList(step.events, input.shots)}
        ${actionList(step.events, input.shots, at)}
        ${
          input.shots?.[step.stepId]
            ? `<figure class="judged"><img class="shot" loading="lazy" src="data:image/webp;base64,${input.shots[step.stepId]}" alt="${escape(
                step.stepId,
              )}"><figcaption class="muted">the screen the step was judged on</figcaption></figure>`
            : ""
        }
        <ol class="events">
          ${step.events
            .map(
              (event) =>
                `<li data-at="${at(event.at).toFixed(2)}"><span class="kind">${escape(event.kind)}</span><span class="t">${at(
                  event.at,
                ).toFixed(1)}s</span> ${escape(event.message)}</li>`,
            )
            .join("")}
        </ol>
        ${logList(logs.get(index))}
      </section>`,
    )
    .join("");

  const callRows = calls
    .map(
      (call) => `<tr>
        <td>${escape(call.stepId ?? "")}</td><td>${escape(call.purpose)}</td><td>${escape(SHOWN[call.channel] ?? "")}</td><td>tier ${call.tier}</td>
        <td>${escape(call.model ?? "")}</td><td class="num">${call.latencyMs}ms</td>
        <td class="num">${call.tokensIn ?? ""}</td><td class="num">${call.usd > 0 ? `$${call.usd.toFixed(4)}` : ""}</td>
      </tr>${conversation(call, input.shots)}`,
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${escape(meta.title)} — ${escape(result.outcome)}</title>
<style>
  :root { color-scheme: light dark; --ok:#15803d; --bad:#b91c1c; --warn:#b45309; --healed:#0369a1; --grey:#64748b; }
  * { box-sizing: border-box; }
  body { margin:0; font: 14px/1.5 -apple-system, system-ui, sans-serif; background:#f8fafc; color:#0f172a; }
  @media (prefers-color-scheme: dark) { body { background:#0b1120; color:#e2e8f0; } .step, .panel, thead { background:#111827 !important; } }
  header.top { padding:16px 20px; border-bottom:1px solid #cbd5e133; display:flex; gap:16px; align-items:baseline; flex-wrap:wrap; }
  h1 { font-size:18px; margin:0; }
  .muted { color:#64748b; font-size:12px; }
  .verdict { font-weight:600; }
  .verdict.ok { color:var(--ok);} .verdict.bad { color:var(--bad);} .verdict.warn { color:var(--warn);} .verdict.healed{color:var(--healed);} .verdict.grey{color:var(--grey);}
  main { display:grid; grid-template-columns: minmax(320px, 420px) 1fr; gap:20px; padding:20px; align-items:start; }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
  video { width:100%; border-radius:12px; background:#000; }
  .rail { display:flex; gap:2px; margin-top:8px; }
  .rail-step { border:0; padding:6px 4px; border-radius:6px; cursor:pointer; color:#fff; font-size:11px; overflow:hidden; white-space:nowrap; }
  .rail-step.ok{background:var(--ok);} .rail-step.bad{background:var(--bad);} .rail-step.warn{background:var(--warn);} .rail-step.healed{background:var(--healed);} .rail-step.grey{background:var(--grey);}
  .rail-step[aria-current="true"] { outline:2px solid #0f172a; outline-offset:1px; }
  .step { background:#fff; border-radius:12px; padding:14px 16px; margin-bottom:12px; border-left:4px solid var(--grey); scroll-margin-top:12px; }
  .step.ok{border-left-color:var(--ok);} .step.bad{border-left-color:var(--bad);} .step.warn{border-left-color:var(--warn);} .step.healed{border-left-color:var(--healed);}
  .step header { display:flex; gap:10px; align-items:baseline; }
  .step h3 { margin:0; font-size:15px; }
  .badge { font-size:11px; padding:2px 6px; border-radius:999px; background:#e2e8f033; }
  .detail { margin:8px 0; }
  .shot { max-width:220px; border-radius:8px; border:1px solid #cbd5e14d; display:block; margin:8px 0; }
  .popups { list-style:none; margin:8px 0; padding:8px 10px; border-radius:10px; background:#0369a10f; font-size:12px; }
  .popups li { display:flex; gap:10px; align-items:center; padding:4px 0; }
  .popups img { width:56px; border-radius:6px; border:1px solid #cbd5e14d; }
  .actions { list-style:none; margin:8px 0; padding:0; display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:10px; }
  .actions li { display:flex; flex-direction:column; gap:4px; font-size:12px; cursor:zoom-in; border-radius:10px; }
  .actions li.big { grid-column:1 / -1; cursor:zoom-out; }
  .actions li.big .frame { max-width:420px; }
  .actions li.now { outline:2px solid var(--healed); outline-offset:2px; }
  .actions li.still strong { color:var(--warn); }
  .frame { position:relative; margin:0; border-radius:8px; overflow:hidden; border:1px solid #cbd5e14d; }
  .frame img { display:block; width:100%; }
  .mark { position:absolute; width:16px; height:16px; margin:-8px 0 0 -8px; border-radius:50%; background:#ef4444; border:2px solid #fff;
    box-shadow:0 0 0 2px #ef4444, 0 0 0 7px #ef444440; pointer-events:none; }
  .box { position:absolute; border:2px solid #f59e0b; border-radius:4px; background:#f59e0b1a; pointer-events:none; }
  .what { display:flex; flex-direction:column; gap:2px; }
  .by { align-self:flex-start; font-size:11px; line-height:1.4; padding:2px 7px; border-radius:6px; background:#64748b1f; color:#475569; }
  .by.memory { background:#15803d1f; color:var(--ok); }
  .by.tree { background:#0369a11f; color:var(--healed); }
  .why { margin:2px 0 0; color:#475569; }
  .tree summary { cursor:pointer; color:#64748b; }
  .tree pre { margin:4px 0 0; padding:6px 8px; border-radius:8px; background:#64748b14; max-height:240px; overflow:auto;
    font:10px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space:pre-wrap; word-break:break-word; }
  .judged { margin:8px 0; }
  .judged .shot { margin:0 0 4px; }
  @media (prefers-color-scheme: dark) { .why, .by { color:#cbd5e1; } .by.memory { color:#4ade80; } .by.tree { color:#38bdf8; } }
  .events { list-style:none; margin:8px 0 0; padding:0; font-size:12px; }
  .events li { padding:2px 0; color:#475569; }
  .events li.now { color:inherit; font-weight:600; }
  .kind { display:inline-block; min-width:78px; color:#64748b; }
  .t { display:inline-block; min-width:44px; color:#94a3b8; }
  .device-log summary { cursor:pointer; color:#64748b; font-size:12px; margin-top:8px; }
  .log { list-style:none; margin:6px 0 0; padding:6px 8px; border-radius:8px; background:#64748b14; max-height:260px; overflow:auto;
    font:11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .log li { white-space:pre-wrap; word-break:break-word; }
  .log li.serious { color:var(--bad); }
  .log li.now { font-weight:600; }
  table { width:100%; border-collapse:collapse; font-size:12px; margin-top:8px; }
  th, td { text-align:left; padding:4px 8px; border-bottom:1px solid #cbd5e133; }
  .num { text-align:right; font-variant-numeric:tabular-nums; }
  .panel { background:#fff; border-radius:12px; padding:14px 16px; }
  .conv > td { padding-top:0; }
  .conv summary { cursor:pointer; color:#64748b; }
  .conv-body { display:flex; gap:12px; align-items:flex-start; margin:6px 0 8px; }
  .conv-body .seen { width:180px; flex:none; border-radius:8px; box-shadow:0 0 0 1px #64748b33; }
  .conv-words { flex:1; min-width:0; }
  .conv pre { margin:4px 0; padding:6px 8px; border-radius:8px; background:#64748b14; max-height:320px; overflow:auto;
    font:11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space:pre-wrap; word-break:break-word; }
  .conv .label { margin:8px 0 0; color:#64748b; font-size:11px; text-transform:uppercase; letter-spacing:.06em; }
  .conv p.muted { margin:4px 0; }
</style></head>
<body>
<header class="top">
  <h1>${escape(meta.title)}</h1>
  <span class="verdict ${OUTCOME_CLASS[result.outcome] ?? "grey"}">${escape(verdictFor(result.outcome, meta.pullRequest === true))}</span>
  <span class="muted">${escape(meta.platform)} · ${escape(meta.device)} · ${escape(meta.engine)}${
    meta.appBuild ? ` · ${escape(meta.appBuild)}` : ""
  }${meta.pullRequest ? " · pull request" : ""}</span>
  <span class="muted">${seconds(total)} · ${calls.length} model calls${
    Object.keys(byTier).length ? ` (${Object.entries(byTier).map(([t, n]) => `tier ${t}: ${n}`).join(", ")})` : ""
  } · ${usd > 0 ? `$${usd.toFixed(4)}` : `${(tokensIn / 1000).toFixed(1)}k input tokens`} · ${
    result.cache.replayed
  }/${result.cache.steps} steps remembered${
    result.popups ? ` · ${result.popups} pop-up${result.popups === 1 ? "" : "s"} answered by your rules` : ""
  }${actionSummary}</span>
</header>
<main>
  <div>
    ${
      input.videoBase64
        ? `<video id="v" controls preload="metadata" src="data:${input.videoMime ?? "video/mp4"};base64,${input.videoBase64}"></video>`
        : `<div class="panel muted">No recording for this run.</div>`
    }
    <div class="rail">${stepRail}</div>
    <p class="muted">Click a step to jump to the moment it ran.</p>
  </div>
  <div>
    ${beforeSteps}
    ${stepCards}
    <div class="panel">
      <strong>Each model call: what it cost, and what it was asked, thought and answered</strong>
      <table><thead><tr><th>step</th><th>purpose</th><th>shown</th><th>tier</th><th>model</th><th class="num">latency</th><th class="num">tokens in</th><th class="num">cost</th></tr></thead>
      <tbody>${callRows}</tbody></table>
    </div>
  </div>
</main>
<script>
  const video = document.getElementById("v");
  const cards = [...document.querySelectorAll(".step")];
  const rail = [...document.querySelectorAll(".rail-step")];

  // An explicit jump wins over the running estimate for a moment, or the
  // highlight snaps back to where the video happens to be a frame later.
  let pinnedUntil = 0;

  function seekTo(seconds, index) {
    if (video) { video.currentTime = Math.max(0, seconds - 1.5); video.play().catch(() => {}); }
    pinnedUntil = Date.now() + 2500;
    rail.forEach((r, i) => r.setAttribute("aria-current", String(i === index)));
    cards[index]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  rail.forEach((button, index) => button.addEventListener("click", () => seekTo(Number(button.dataset.seek), index)));
  for (const action of document.querySelectorAll(".actions li")) {
    action.addEventListener("click", (event) => {
      event.stopPropagation();
      action.classList.toggle("big");
      if (video) { video.currentTime = Math.max(0, Number(action.dataset.at) - 0.5); }
    });
  }
  cards.forEach((card, index) => card.addEventListener("click", () => seekTo(Number(card.dataset.seek), index)));

  // As the video plays, the events of that moment are the ones highlighted.
  video?.addEventListener("timeupdate", () => {
    const now = video.currentTime;
    for (const li of document.querySelectorAll(".events li, .log li, .actions li")) {
      const at = Number(li.dataset.at);
      li.classList.toggle("now", at <= now && now - at < 2);
    }
    // The lead-in is deliberate -- you want the second before the step, not
    // the step itself -- so the rail must count it as already being there,
    // or the highlight sits one step behind every time you jump.
    if (Date.now() < pinnedUntil) return;
    const current = cards.findIndex((card) => Number(card.dataset.seek) > now + 1.6);
    const index = current === -1 ? cards.length - 1 : Math.max(0, current - 1);
    rail.forEach((r, i) => r.setAttribute("aria-current", String(i === index)));
  });

  // Open on the first thing that went wrong, because that is why this file was
  // opened at all.
  const firstBad = cards.findIndex((card) => card.classList.contains("bad") || card.classList.contains("warn"));
  if (firstBad >= 0) seekTo(Number(cards[firstBad].dataset.seek), firstBad);
</script>
</body></html>`;
}
