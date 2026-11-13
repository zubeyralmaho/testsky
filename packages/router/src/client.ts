/**
 * A thin OpenAI-compatible vision client.
 *
 * Deliberately thin: no SDK, no retries-with-jitter framework, no provider
 * abstraction layer. Every serious VLM host speaks /chat/completions with
 * image_url parts -- cloud gateways, OpenRouter and a local vLLM alike -- and
 * the one thing we genuinely need from the transport is the token usage, which
 * an SDK would hide behind its own types anyway. One rule of waiting: a host
 * that says it is busy is asked again when it says to.
 */

import type { Provenance } from "@testsky/engine-core";
import sharp from "sharp";

import type { ModelConfig } from "./config.ts";

/**
 * A frame goes to a model as a JPEG. Measured through an OpenAI-compatible
 * gateway, with the same tokens billed: a Nothing's 1.5 MB PNG was answered in
 * 2.2 s and its 0.31 MB JPEG in 1.5 s, a 12 mini's 2.8 MB in 3.2 s and its
 * 0.40 MB in 1.5 s. Some gateways also refuse an image over a few megabytes,
 * and a 12 mini's screen with a video and an advert on it came to 4.3 MB of
 * PNG. Bytes that are not a picture go as they came.
 */
async function forModel(image: Buffer): Promise<string> {
  const jpeg = await sharp(image).jpeg({ quality: 85 }).toBuffer().catch(() => undefined);
  return jpeg ? `data:image/jpeg;base64,${jpeg.toString("base64")}` : `data:image/png;base64,${image.toString("base64")}`;
}

export class ModelError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ModelError";
    if (status !== undefined) this.status = status;
  }
}

/**
 * Whether a call came back with nothing to read -- silent, overloaded, out of
 * room -- as against refused. A refused call is a wrong key or a model nobody
 * serves: a mistake in the set-up, which another model answering would only hide.
 */
export function gaveNoAnswer(error: unknown): boolean {
  return error instanceof ModelError && (error.status === undefined || error.status === 429 || error.status >= 500);
}

export interface VisionAsk {
  system: string;
  user: string;
  /** PNG/WebP bytes. Omitted for a tree-only (blind screen) question. */
  image?: Buffer;
  /** The user text carries the screen's accessibility tree. */
  tree?: boolean;
  /** The tree's own lines, exactly as they appear in `user`: for the call's record, which shows them apart. Not sent twice. */
  treeLines?: string;
  /** Lower is more repeatable; grounding wants near-zero. */
  temperature?: number;
}

export interface VisionAnswer {
  text: string;
  provenance: Provenance;
  /** What the model thought before it answered, word for word, when its host sends it back. */
  reasoning?: string;
}

/** The message of a chat completion, as far as an answer and the thinking before it go. */
interface ChatMessage {
  content?: string;
  /** OpenRouter's thinking. */
  reasoning?: string;
  /** vLLM's and DeepSeek's. */
  reasoning_content?: string;
  /** OpenRouter's thinking in parts: text, or a summary of it. */
  reasoning_details?: { text?: unknown; summary?: unknown }[];
}

const THINK = /^\s*<think>([\s\S]*?)<\/think>/i;

/**
 * What a model thought before it answered, when its host says: in a field of
 * its own -- each host names it differently -- or, from hosts that leave it in
 * the answer, the <think> block the answer opens with. Nothing is asked for
 * that was not already coming: thinking a host does not send is not bought for
 * a report.
 */
export function reasoningOf(message: ChatMessage | undefined): string | undefined {
  if (!message) return undefined;
  const parts = [
    message.reasoning,
    message.reasoning_content,
    ...(Array.isArray(message.reasoning_details)
      ? message.reasoning_details.map((detail) => (typeof detail?.text === "string" ? detail.text : typeof detail?.summary === "string" ? detail.summary : undefined))
      : []),
  ].filter((part): part is string => typeof part === "string" && part.trim() !== "");
  // OpenRouter sends the same thinking as one string and again in parts.
  const said = [...new Set(parts.map((part) => part.trim()))];
  if (said.length > 1 && said.slice(1).every((part) => said[0]!.includes(part))) said.splice(1);
  if (said.length) return said.join("\n\n");
  const think = typeof message.content === "string" ? THINK.exec(message.content)?.[1]?.trim() : undefined;
  return think || undefined;
}

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** What the call cost, in dollars, when the host says so -- OpenRouter does, when asked. */
  cost?: number;
}

/**
 * What a call cost: the host's own figure when it gives one, else the tokens
 * at the configured prices, else nothing -- and a report then says tokens.
 */
function usd(cfg: ModelConfig, usage: ChatUsage | undefined): number {
  if (!usage) return 0;
  if (typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0) return usage.cost;
  const inM = (usage.prompt_tokens ?? 0) / 1_000_000;
  const outM = (usage.completion_tokens ?? 0) / 1_000_000;
  return inM * (cfg.priceInPerM ?? 0) + outM * (cfg.priceOutPerM ?? 0);
}

/** OpenRouter: it reports what each call cost when asked, and takes provider preferences. */
const onOpenRouter = (cfg: ModelConfig): boolean => {
  try {
    return new URL(cfg.baseUrl).host === "openrouter.ai";
  } catch {
    return false;
  }
};

/**
 * "Too many requests", "unavailable", "overloaded": the host is busy, not the
 * question wrong. A gateway may allow only so many requests a minute per key,
 * and six phones' runs side by side can pass that; a run that failed on it
 * would be our plumbing in a report about an app.
 */
const BUSY = new Set([429, 503, 529]);
const BUSY_TRIES = 6;
const BUSY_WAIT_MS = 1000;
const BUSY_WAIT_CEILING_MS = 60_000;

/** How long a busy host asked to be left alone: its Retry-After, in seconds or as a date, else doubling waits. */
function busyWait(response: Response, attempt: number): number {
  const said = response.headers.get("retry-after");
  if (said) {
    const seconds = Number(said);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(said) - Date.now();
    if (Number.isFinite(ms)) return Math.min(Math.max(ms, 0), BUSY_WAIT_CEILING_MS);
  }
  return Math.min(BUSY_WAIT_MS * 2 ** attempt, BUSY_WAIT_CEILING_MS);
}

export async function askVision(
  cfg: ModelConfig,
  ask: VisionAsk,
  tier: Provenance["tier"],
): Promise<VisionAnswer> {
  const content: Record<string, unknown>[] = [{ type: "text", text: ask.user }];
  if (ask.image) {
    content.push({ type: "image_url", image_url: { url: await forModel(ask.image) } });
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

  const body = JSON.stringify({
    model: cfg.model,
    ...(cfg.temperature === false ? {} : { temperature: ask.temperature ?? 0 }),
    // No max_tokens unless the host will not answer without one, and then the
    // model's own limit: a cap sized for the answer cut off every model that
    // thinks before it answers -- empty or half answers from Claude Haiku and
    // Sonnet 5.5 in lab runs -- and a per-model floor was one more number to
    // get wrong. What a test may spend is bounded by its budget, not by the
    // length of an answer.
    ...(cfg.maxTokens ? { max_tokens: cfg.maxTokens } : {}),
    messages: [
      { role: "system", content: ask.system },
      { role: "user", content },
    ],
    ...(onOpenRouter(cfg) ? { usage: { include: true }, ...(cfg.provider ? { provider: cfg.provider } : {}) } : {}),
  });

  const startedAt = Date.now();
  let response: Response;
  let reply = "";
  // A call that never answered is asked once more: a cheap OpenRouter host
  // sat on three of 48 calls past the minute in a lab run, and each one cost a
  // run as DEVICE_ERROR. Twice silent is the host's answer. The answer's body
  // is part of the call: OpenRouter sends its headers at once and the body
  // when a host has answered, so a slow host runs out the time while the body
  // is read -- 13 runs of 500 failed so in a lab campaign, each exactly at the
  // limit, and none was asked again.
  let silent = 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 60_000),
      });
      if (BUSY.has(response.status) && attempt + 1 < BUSY_TRIES) {
        const wait = busyWait(response, attempt);
        await response.body?.cancel().catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }
      reply = await response.text();
      break;
    } catch (error) {
      silent += 1;
      if (silent < 2) continue;
      throw new ModelError(`${cfg.model} at ${cfg.baseUrl} did not answer: ${(error as Error).message}`);
    }
  }

  if (!response.ok) {
    throw new ModelError(`${cfg.model} returned ${response.status}: ${reply.slice(0, 400)}`, response.status);
  }

  let payload: {
    choices?: { message?: ChatMessage; finish_reason?: string }[];
    usage?: ChatUsage;
    provider?: string;
  };
  try {
    payload = JSON.parse(reply) as typeof payload;
  } catch {
    throw new ModelError(`${cfg.model} returned a reply that is not JSON: ${reply.slice(0, 200)}`);
  }
  const choice = payload.choices?.[0];
  const text = choice?.message?.content;
  if (typeof text !== "string") {
    throw new ModelError(`${cfg.model} returned no message content`);
  }
  if (choice?.finish_reason === "length") {
    // Half a JSON object parses as "the model is broken" if you let it get
    // that far. It is not broken; it ran out of room mid-sentence.
    throw new ModelError(`${cfg.model} was cut off at its own output limit, mid-answer`);
  }

  const provenance: Provenance = {
    tier,
    model: cfg.model,
    usd: usd(cfg, payload.usage),
    latencyMs: Date.now() - startedAt,
    usedTree: ask.tree === true || !ask.image,
    // Both is neither: an answer from the picture with the tree beside it is
    // not the answer a picture alone would have given.
    channel: ask.image ? (ask.tree ? "fused" : "vision") : "tree",
  };
  if (typeof payload.provider === "string" && payload.provider) provenance.provider = payload.provider;
  if (payload.usage?.prompt_tokens !== undefined) provenance.tokensIn = payload.usage.prompt_tokens;
  if (payload.usage?.completion_tokens !== undefined) provenance.tokensOut = payload.usage.completion_tokens;

  const reasoning = reasoningOf(choice?.message);
  return { text, provenance, ...(reasoning ? { reasoning } : {}) };
}

/**
 * Pulls the JSON object out of a model's answer.
 *
 * Models wrap JSON in prose and in ```json fences no matter how firmly the
 * prompt forbids it, and a run that dies on a stray backtick is a worse
 * product than one that reads around it. The cheaper ones also quote inside a
 * string -- `"the field reads "4k video" now"` -- and follow an answer with a
 * "corrected" one: a quote is mended, and an answer given twice is read once.
 * Every answer in it has to be read, and all of them alike: a correction that
 * cannot be read would leave standing the answer the model took back.
 */
export function parseJsonAnswer<T>(text: string): T {
  // A fence is a wrapper, not a choice: an answer fenced twice is two answers.
  const candidate = text.replace(/```(?:json)?/gi, "");
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new ModelError(`expected JSON, got: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch (error) {
    const read = objectsIn(candidate).map((object) => {
      if (object === undefined) return undefined;
      try {
        return { answer: JSON.parse(object) as T };
      } catch {
        return undefined;
      }
    });
    if (read.length && read.every((each) => each !== undefined)) {
      const answers = new Set(read.map((each) => JSON.stringify(each!.answer)));
      if (answers.size === 1) return read[0]!.answer;
      throw new ModelError(`the model gave ${answers.size} different answers in one: ${text.slice(0, 200)}`);
    }
    throw new ModelError(`could not parse the model's JSON (${(error as Error).message}): ${text.slice(0, 200)}`);
  }
}

/**
 * Every top-level object in a model's answer that opens on a key, its strings
 * mended; one that cannot be, or is still open at the end, as undefined.
 *
 * A quote closes a string only where JSON could go on after one -- before a
 * comma, a colon or a closing bracket -- which is all that tells it from a
 * quote the model meant as text; that one is escaped, and so is a line break.
 * In JSON that was valid to begin with, every quote is read as it was. A key
 * met twice in one object is a string read as ending early: in
 * `"reason": "the row reads "x", "pass": true}` it would overrule the answer.
 */
function objectsIn(text: string): (string | undefined)[] {
  const objects: (string | undefined)[] = [];
  let object = "";
  let depth = 0;
  let inString = false;
  let stringFrom = 0;
  let keys: Set<string>[] = [];
  let sound = true;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (depth === 0) {
      // Prose has braces too -- "the {name} field" -- and an answer opens on a key.
      if (char === "{" && text.slice(i + 1).trimStart().startsWith('"')) {
        object = char;
        depth = 1;
        keys = [new Set()];
        sound = true;
      }
      continue;
    }
    if (inString) {
      if (char === "\\") {
        object += char + (text[i + 1] ?? "");
        i += 1;
      } else if (char === '"') {
        const next = text.slice(i + 1).trimStart()[0];
        inString = next !== undefined && !",:}]".includes(next);
        if (!inString && next === ":") {
          const key = object.slice(stringFrom);
          const own = keys[keys.length - 1]!;
          if (own.has(key)) sound = false;
          own.add(key);
        }
        object += inString ? '\\"' : char;
      } else {
        object += char === "\n" ? "\\n" : char === "\r" ? "\\r" : char === "\t" ? "\\t" : char;
      }
      continue;
    }
    object += char;
    if (char === '"') {
      inString = true;
      stringFrom = object.length;
    } else if (char === "{") {
      depth += 1;
      keys.push(new Set());
    } else if (char === "}") {
      depth -= 1;
      keys.pop();
      if (depth === 0) objects.push(sound ? object : undefined);
    }
  }
  if (depth > 0) objects.push(undefined);
  return objects;
}
