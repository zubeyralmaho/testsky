/**
 * The playground's server: a phone, testsky's engine, and four routes.
 *
 * Midscene's playground UI talks to Midscene's own agent through a server of
 * a few thousand lines. This one goes the other way: the UI gets a small SDK
 * that talks to these routes, and every instruction runs through testsky's
 * executor as a one-step test -- the same planner, grounding, memory and
 * checks a real run uses -- and comes back in the dump format the UI already
 * knows how to replay.
 *
 * It binds to localhost and serves one person: there is one phone, and one
 * instruction runs at a time.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { DeviceHandle, Engine, GroundResult } from "@testsky/engine-core";
import { inlineScreenshots, locateDump, toMidsceneDump } from "@testsky/evidence";
import { boxWords, StepSession, type SavedStep, type StepBody } from "@testsky/harness";
import { toJpeg } from "@testsky/perception";
import type { CostLedger } from "@testsky/router";

import { type ScreenStreamOptions, streamScreen } from "./screen.ts";

export interface PlaygroundOptions {
  engine: Engine & { stepId?: string };
  device: DeviceHandle;
  ledger: CostLedger;
  /** The built playground page. */
  page: string;
  /** 0 picks a free port. */
  port?: number;
  host?: string;
  /** Let the screen settle between actions, as a run does. Tests turn it off. */
  settle?: boolean;
  /** Starts the phone's encoder for the live screen; tests give a fake. */
  record?: ScreenStreamOptions["record"];
  /** The test file "save as a step" writes to, begun if it is not there yet. */
  test?: string;
  /** The app a begun test file targets; on Android, the app in front is taken when this is not given. */
  app?: string;
}

export interface Playground {
  url: string;
  close(): Promise<void>;
}

/** What the UI answers with, in the shape Midscene's playground reads. */
export interface ExecuteResponse {
  result: unknown;
  dump: unknown;
  reportHTML: null;
  error: string | null;
  /**
   * What only testsky's page reads: the instruction, for saving it as a step,
   * and the playground it ran in -- a page kept from before a restart holds
   * instructions this one never ran.
   */
  testsky?: { instruction: string; session: string; savable: boolean };
}

export type { SavedStep } from "@testsky/harness";

export class PlaygroundError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PlaygroundError";
    this.status = status;
  }
}

/**
 * An instruction as a step of a test: something to do, something that must
 * hold, or something to read off the screen. Midscene's interaction verbs
 * become the plain English a testsky step is written in.
 */
export function stepFor(type: string, prompt: string, params: Record<string, unknown> = {}): StepBody {
  const text = (key: string) => (typeof params[key] === "string" ? (params[key] as string) : "");
  switch (type) {
    case "aiAct":
      return { do: prompt };
    case "aiTap":
      return { do: `tap ${prompt}` };
    case "aiDoubleClick":
      return { do: `double-tap ${prompt}` };
    case "aiRightClick":
      return { do: `long-press ${prompt}` };
    case "aiInput":
      // Without the value field the prompt is the whole instruction: "shoes into the search field".
      return { do: text("value") ? `type "${text("value")}" into ${prompt}` : `type ${prompt}` };
    case "aiKeyboardPress":
      return { do: `press the ${text("keyName") || prompt} key` };
    case "aiScroll":
      return { do: `scroll ${text("direction") || "down"}${prompt ? ` on ${prompt}` : ""}` };
    case "aiAssert":
    case "aiWaitFor":
      return { expect: prompt };
    case "aiQuery":
    case "aiBoolean":
    case "aiNumber":
    case "aiString":
    case "aiAsk":
      return { extract: { answer: prompt } };
    default:
      throw new PlaygroundError(400, `"${type}" is not something testsky does on a phone`);
  }
}

const FOUND_BY: Record<NonNullable<GroundResult["foundBy"]>, string> = {
  both: "the model and the tree agree",
  tree: "the tree, with no picture for the model",
  model: "the model; the tree names nothing there",
};

/** What a Locate says in the conversation: where testsky would press, and what the tree alone would say. */
export function locateWords(found: GroundResult | undefined, refused: string | undefined, tree: string | undefined): string {
  const testsky = found
    ? `testsky would press (${Math.round(found.point.x)}, ${Math.round(found.point.y)})` +
      (found.rect ? ` in ${boxWords(found.rect)}` : "") +
      (found.foundBy ? `: ${FOUND_BY[found.foundBy]}` : "") +
      (found.why ? ` -- ${found.why}` : "")
    : `testsky would press nothing: ${refused ?? "nothing was found"}`;
  return tree ? `${testsky}.\nThe tree alone: ${tree}.` : `${testsky}.`;
}

/** PNG or WebP, by the bytes' own signature. */
function mimeOf(bytes: Buffer): string {
  if (bytes.subarray(0, 4).toString("binary") === "\x89PNG") return "image/png";
  if (bytes.subarray(0, 4).toString("binary") === "RIFF" && bytes.subarray(8, 12).toString("binary") === "WEBP") return "image/webp";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  return "application/octet-stream";
}

const LIMIT = 1024 * 1024;

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > LIMIT) throw new PlaygroundError(413, "an instruction is never this long");
    chunks.push(chunk as Buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Falls through to the refusal below.
  }
  throw new PlaygroundError(400, "the body is not a JSON object");
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

export async function startPlayground(options: PlaygroundOptions): Promise<Playground> {
  const { engine, device, ledger } = options;
  const session = new StepSession({ engine, device, ledger, settle: options.settle ?? true });
  /** An answer being made for the page: the phone is free by then, the playground not yet. */
  let responding = false;
  const busy = () => session.busy || responding;

  /** The live screens being watched, and when each has stopped. Closing the playground ends them, and with them the phone's encoders. */
  const watching = new Map<ServerResponse, Promise<void>>();

  const screenshot = async () => {
    const { latest } = session;
    // A frame younger than this is the same picture; polling should not cost a capture each time.
    if (latest && (busy() || Date.now() - latest.at < 400)) return latest;
    if (busy()) throw new PlaygroundError(503, "an instruction is running and has not taken a frame yet");
    await session.look(false);
    return session.latest!;
  };

  /** Where testsky would press for a description, pressing nothing, as the conversation and the replay show it. */
  const locate = async (description: string): Promise<ExecuteResponse> => {
    const located = await session.locate(description);
    const { observation, found, refused, tree } = located;
    const { dump, images } = locateDump({
      description,
      meta: { platform: device.platform, device: device.id },
      shot: (await toJpeg(observation.frame.bytes)).toString("base64"),
      size: observation.frame.size,
      at: observation.frame.capturedAt,
      calls: located.calls,
      ...(found
        ? {
            found: {
              point: found.point,
              ...(found.rect ? { rect: found.rect } : {}),
              ...(found.foundBy ? { foundBy: found.foundBy } : {}),
              ...(found.why ? { why: found.why } : {}),
              confidence: found.confidence,
            },
          }
        : {}),
      ...(refused ? { refused } : {}),
      ...(tree ? { tree } : {}),
    });
    return {
      result: locateWords(found, refused, tree),
      dump: inlineScreenshots(dump, images),
      reportHTML: null,
      error: null,
    };
  };

  /** An instruction as a step of the test file "save as a step" was given, with what the run learned. */
  const save = async (id: string, from: unknown): Promise<SavedStep> => {
    if (from !== session.id) throw new PlaygroundError(410, "that instruction was run before the playground restarted: run it again to save it");
    session.savable(id);
    const path = options.test;
    if (!path) throw new PlaygroundError(400, "start the playground with --test <file.testsky.yaml> to save steps");
    try {
      return await session.save(id, { test: path, ...(options.app ? { app: options.app } : {}) });
    } catch (error) {
      if ((error as { reason?: string }).reason === "no-app") {
        throw new PlaygroundError(400, "start the playground with --app <id> to begin a test file: a test names the app it runs");
      }
      throw error;
    }
  };

  const execute = async (instruction: Record<string, unknown>): Promise<ExecuteResponse> => {
    const type = typeof instruction.type === "string" ? instruction.type : "";
    const prompt = typeof instruction.prompt === "string" ? instruction.prompt.trim() : "";
    const params =
      instruction.params && typeof instruction.params === "object" && !Array.isArray(instruction.params)
        ? (instruction.params as Record<string, unknown>)
        : {};
    if (!type) throw new PlaygroundError(400, "an instruction needs a type");
    if (!prompt && type !== "aiKeyboardPress" && type !== "aiScroll") throw new PlaygroundError(400, "an instruction needs a prompt");
    if (busy()) throw new PlaygroundError(409, "an instruction is already running");
    if (type === "aiLocate") return answering(() => locate(prompt));
    const step = stepFor(type, prompt, params);
    return answering(() => ran(step, prompt || type));
  };

  /** Busy until the page has its answer, not only until the phone is done. */
  const answering = async (work: () => Promise<ExecuteResponse>): Promise<ExecuteResponse> => {
    responding = true;
    try {
      return await work();
    } finally {
      responding = false;
    }
  };

  /** An instruction run, and its replay made. */
  const ran = async (step: StepBody, title: string): Promise<ExecuteResponse> => {
    const tried = await session.attempt(step, title);
    const jpegs = Object.fromEntries(
      await Promise.all([...tried.shots].map(async ([id, bytes]) => [id, (await toJpeg(bytes)).toString("base64")] as const)),
    );
    const { dump, images } = toMidsceneDump({
      result: tried.result,
      events: tried.events,
      calls: tried.calls,
      meta: { test: "playground", title, platform: device.platform, device: device.id, engine: engine.name },
      shots: jpegs,
    });
    return {
      result: tried.answer,
      dump: inlineScreenshots(dump, images),
      reportHTML: null,
      error: tried.failure,
      testsky: { instruction: tried.id, session: session.id, savable: Boolean(step.do || step.expect) && Boolean(options.test) },
    };
  };

  const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://playground.local");
    const at = `${request.method} ${url.pathname}`;
    if (at === "GET /" || at === "GET /index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(options.page);
      return;
    }
    if (at === "GET /api/status") {
      send(response, 200, {
        platform: device.platform,
        device: device.id,
        kind: device.kind,
        engine: engine.name,
        size: device.size ?? null,
        // The screen as last seen: a turned phone is measured again on every look.
        screen: session.latest?.size ?? device.size ?? null,
        // Android streams its screen as it moves (screen.ts); anything else is polled.
        live: device.platform === "android",
        // Where "save as a step" writes, if anywhere.
        test: options.test ?? null,
        session: session.id,
        tree: engine.capabilities.tree,
        busy: busy(),
      });
      return;
    }
    if (at === "GET /api/screen") {
      if (device.platform !== "android") throw new PlaygroundError(404, "only an Android phone streams its screen; this one is polled");
      const size = session.latest?.size ?? device.size ?? (await session.look(false)).frame.size;
      const streaming = streamScreen(response, { serial: device.id, size, ...(options.record ? { record: options.record } : {}) });
      watching.set(response, streaming);
      try {
        await streaming;
      } finally {
        watching.delete(response);
      }
      return;
    }
    if (at === "GET /api/screenshot") {
      const frame = await screenshot();
      response.writeHead(200, {
        "content-type": mimeOf(frame.bytes),
        "cache-control": "no-store",
        "x-screen-width": String(frame.size.width),
        "x-screen-height": String(frame.size.height),
      });
      response.end(frame.bytes);
      return;
    }
    if (at === "GET /api/tree") {
      if (!engine.capabilities.tree) throw new PlaygroundError(404, "this device gives no accessibility tree");
      if (busy()) throw new PlaygroundError(409, "an instruction is running; the tree can be read when it is done");
      const observation = await session.look(true);
      if (!observation.tree) throw new PlaygroundError(503, "the device gave no tree this time");
      send(response, 200, { size: observation.frame.size, ...observation.tree });
      return;
    }
    if (at === "POST /api/execute") {
      send(response, 200, await execute(await readJson(request)));
      return;
    }
    if (at === "POST /api/steps") {
      const body = await readJson(request);
      if (typeof body.instruction !== "string") throw new PlaygroundError(400, "say which instruction to save");
      send(response, 200, await save(body.instruction, body.session));
      return;
    }
    send(response, 404, { error: `nothing at ${at}` });
  };

  const server = createServer((request, response) => {
    route(request, response).catch((error: unknown) => {
      if (response.headersSent) return response.end();
      // By name: the session's refusals carry a status of their own, and a
      // class loaded twice by pnpm's links answers instanceof with false.
      const named = (error as Error).name === "PlaygroundError" || (error as Error).name === "StepError";
      const status = named ? (error as PlaygroundError).status : 500;
      send(response, status, { error: (error as Error).message });
    });
  });

  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 5800, host, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`,
    close: async () => {
      // A stream never ends by itself, and the server would wait for it for ever.
      const streams = [...watching];
      for (const [response] of streams) response.destroy();
      await Promise.all(streams.map(([, stopped]) => stopped));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
