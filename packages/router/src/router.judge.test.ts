import assert from "node:assert/strict";
import test from "node:test";

import type { AssertRequest, Observation, TreeNode } from "@testsky/engine-core";
import sharp from "sharp";

import { CostLedger } from "./ledger.ts";
import { Router } from "./router.ts";

async function picture(text: string, clock = "9:41"): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="2160">
    <rect width="100%" height="100%" fill="#f2f4f7"/>
    <text x="60" y="70" font-family="Helvetica" font-size="44" fill="#111827">${clock}</text>
    <rect x="180" y="1680" width="720" height="216" rx="40" fill="#2563eb"/>
    <text x="400" y="1810" font-family="Helvetica" font-size="72" fill="#ffffff">${text}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function pay(enabled: boolean): TreeNode {
  return {
    ref: "root",
    role: "Window",
    bounds: { x: 0, y: 0, width: 360, height: 720 },
    enabled: true,
    interactive: false,
    children: [{ ref: "pay", role: "Button", label: "Pay", bounds: { x: 60, y: 560, width: 240, height: 72 }, enabled, interactive: true, children: [] }],
  };
}

function observation(bytes: Buffer, over: Partial<Observation> = {}): Observation {
  return {
    frame: { bytes, capturedAt: 0, size: { width: 360, height: 720 }, pixelRatio: 3 },
    visionBlind: false,
    visionStats: { meanLuma: 200, stdLuma: 20, uniqueColors: 40 },
    signature: { phash: "abc", maskedRegions: [] },
    appContext: {},
    observedAt: 0,
    tree: { platform: "android", capturedAt: 0, source: "uiautomator", truncated: false, captureMs: 40, root: pay(true) },
    ...over,
  };
}

const router = (model = "judge-a") => new Router({ tiers: { ground: { baseUrl: "http://127.0.0.1:1/v1", model } } }, new CostLedger());
const ask = (seen: Observation, assertion = "the Pay button is enabled", channel?: "vision" | "tree"): AssertRequest => ({
  observation: seen,
  assertion,
  ...(channel ? { channel } : {}),
});

test("the same question on the same screen, to the same model, has the same print", async () => {
  const screen = observation(await picture("Pay"));
  const print = await router().judgePrint(ask(screen));
  assert.ok(print);
  assert.equal(await router().judgePrint(ask(observation(await picture("Pay")))), print);
  assert.notEqual(await router().judgePrint(ask(screen, "the Pay button is disabled")), print, "another question");
  assert.notEqual(await router("judge-b").judgePrint(ask(screen)), print, "another model, who may answer otherwise");
});

test("a button the tree says is disabled is another question, though its pixels have not changed", async () => {
  const bytes = await picture("Pay");
  const enabled = await router().judgePrint(ask(observation(bytes)));
  const disabled = await router().judgePrint(ask(observation(bytes, { tree: { platform: "android", capturedAt: 0, source: "uiautomator", truncated: false, captureMs: 40, root: pay(false) } })));
  assert.notEqual(disabled, enabled);
});

test("asked of the tree alone, the print is the tree's, because the picture is not shown", async () => {
  const onTree = await router().judgePrint(ask(observation(await picture("Pay")), "the Pay button is enabled", "tree"));
  assert.equal(await router().judgePrint(ask(observation(await picture("Checkout")), "the Pay button is enabled", "tree")), onTree);
  assert.notEqual(await router().judgePrint(ask(observation(await picture("Checkout")))), onTree, "and asked of the picture, a new one is a new question");
});

test("the status bar's clock moving on is the same question -- unless the question is about the time", async () => {
  const at = async (clock: string, assertion = "the Pay button is enabled") => router().judgePrint(ask(observation(await picture("Pay", clock)), assertion));
  assert.equal(await at("9:42"), await at("9:41"));
  assert.notEqual(await at("9:42", "the time reads 9:42"), await at("9:41", "the time reads 9:42"));
  // Turned, a phone's top rows are the app's.
  const turned = async (clock: string) => {
    const seen = observation(await picture("Pay", clock));
    return router().judgePrint(ask({ ...seen, frame: { ...seen.frame, size: { width: 720, height: 360 } } }));
  };
  assert.notEqual(await turned("9:42"), await turned("9:41"));
});

test("a frame with no usable picture has no print", async () => {
  assert.equal(await router().judgePrint(ask(observation(await picture("Pay"), { visionBlind: true }))), undefined);
});

test("an answer that gives no verdict is asked again, never read as a failure", async () => {
  // z-ai/glm-5.3-flash on an fp4 host, fourteen times in one round: the verdict's key came out as "pad".
  const replies = [
    '{"reason": "The Battery page is open and displays the current charge level as 81%.", "pad": true}',
    '{"reason": "The Battery page is open and displays the current charge level as 81%.", "pass": true}',
  ];
  const asked: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { messages: { role: string; content: string | { type: string; text?: string }[] }[] };
    const user = body.messages.find((message) => message.role === "user")!.content;
    asked.push(typeof user === "string" ? user : user.map((part) => part.text ?? "").join("\n"));
    const content = replies[Math.min(asked.length - 1, replies.length - 1)];
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  try {
    const { Router } = await import("./router.ts");
    const { fixtureScreen } = await import("@testsky/perception");
    const frame = (await fixtureScreen()).png;
    const observation = {
      frame: { bytes: frame, capturedAt: 0, size: { width: 360, height: 720 }, pixelRatio: 3 },
      visionBlind: false,
      visionStats: { meanLuma: 100, stdLuma: 30, uniqueColors: 90 },
      signature: { phash: "abc", maskedRegions: [] },
      appContext: {},
      observedAt: Date.now(),
    };
    const router = new Router({ tiers: { ground: { baseUrl: "http://stub/v1", model: "cheap" } } });
    const verdict = await router.assert({ observation, assertion: "the Battery page is open and shows the battery's charge level as a percentage" });
    assert.equal(verdict.pass, true);
    assert.equal(asked.length, 2, "asked again once");

    asked.length = 0;
    replies.splice(1, 1, replies[0]!);
    await assert.rejects(router.assert({ observation, assertion: "the Battery page is open" }), /gives no "pass" verdict/);
  } finally {
    globalThis.fetch = original;
  }
});
