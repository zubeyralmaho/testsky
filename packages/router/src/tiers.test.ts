import assert from "node:assert/strict";
import test from "node:test";

import type { Observation } from "@testsky/engine-core";
import { fixtureScreen } from "@testsky/perception";

import { Router } from "./router.ts";

const FRAME = (await fixtureScreen()).png;

function observation(): Observation {
  return {
    frame: { bytes: FRAME, capturedAt: 0, size: { width: 360, height: 720 }, pixelRatio: 3 },
    visionBlind: false,
    visionStats: { meanLuma: 200, stdLuma: 30, uniqueColors: 90 },
    signature: { phash: "abc", maskedRegions: [] },
    appContext: {},
    observedAt: Date.now(),
  };
}

/** Records which model each call went to. */
function stubModels(answer: unknown): { asked: string[]; restore: () => void } {
  const asked: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { model: string };
    asked.push(`${new URL(url).host}:${body.model}`);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  return { asked, restore: () => { globalThis.fetch = original; } };
}

const LADDER = {
  tiers: {
    ground: { baseUrl: "http://local:8000/v1", model: "ui-venus" },
    reason: { baseUrl: "https://cloud/v1", model: "flash" },
  },
};

const BUDGET = { maxUsd: 1, maxLatencyMs: 10_000, maxEscalations: 2 };

test("finding an element goes to the cheap model; judging one goes to the better", async () => {
  const stub = stubModels({ found: true, point: [500, 500], pass: true, reason: "yes" });
  try {
    const router = new Router(LADDER);
    await router.ground({ observation: observation(), description: "the blue button", budget: { ...BUDGET, maxEscalations: 0 } });
    await router.assert({ observation: observation(), assertion: "the button is there" });
    await router.plan({ observation: observation(), goal: "press it", history: [], actionSpace: ["tap"], budget: BUDGET });

    assert.deepEqual(stub.asked, ["local:8000:ui-venus", "cloud:flash", "cloud:flash"]);
  } finally {
    stub.restore();
  }
});

test("an escalation is a different model, not the same one asked twice", async () => {
  // The tree has a control and the answer is on none of it: the sources
  // disagree, which is worth a second look when a better tier exists.
  const stub = stubModels({ found: true, point: [500, 500] });
  const button = { ref: "b", role: "Button", label: "Save", bounds: { x: 20, y: 640, width: 320, height: 48 }, enabled: true, interactive: true, children: [] };
  try {
    const router = new Router({ tiers: { ...LADDER.tiers } });
    const result = await router.ground({
      observation: { ...observation(), tree: { platform: "android", capturedAt: 0, source: "uiautomator", truncated: false, captureMs: 1, root: { ref: "r", role: "View", bounds: { x: 0, y: 0, width: 360, height: 720 }, enabled: true, interactive: false, children: [button] } } },
      description: "the blue button",
      budget: BUDGET,
    });
    assert.deepEqual(stub.asked, ["local:8000:ui-venus", "cloud:flash"]);
    assert.ok(result.confidence <= 0.65);
  } finally {
    stub.restore();
  }
});

test("with one model configured the ladder is a no-op", async () => {
  const stub = stubModels({ found: true, point: [500, 500], pass: true, reason: "yes" });
  try {
    const router = new Router({ tiers: { ground: LADDER.tiers.ground } });
    await router.assert({ observation: observation(), assertion: "the button is there" });
    assert.deepEqual(stub.asked, ["local:8000:ui-venus"]);
  } finally {
    stub.restore();
  }
});

test("a model kept for the second look is asked only for second looks", async () => {
  const stub = stubModels({ found: true, point: [500, 500], pass: true, reason: "yes" });
  const button = { ref: "b", role: "Button", label: "Save", bounds: { x: 20, y: 640, width: 320, height: 48 }, enabled: true, interactive: true, children: [] };
  const tree = { platform: "android" as const, capturedAt: 0, source: "uiautomator" as const, truncated: false, captureMs: 1, root: { ref: "r", role: "View", bounds: { x: 0, y: 0, width: 360, height: 720 }, enabled: true, interactive: false, children: [button] } };
  try {
    const router = new Router({
      tiers: {
        ground: { baseUrl: "http://local:8000/v1", model: "ui-venus" },
        escalation: { baseUrl: "https://openrouter.ai/api/v1", model: "google/gemini-3.8-flash" },
      },
    });
    await router.plan({ observation: observation(), goal: "press it", history: [], actionSpace: ["tap"], budget: BUDGET });
    await router.assert({ observation: observation(), assertion: "the button is there" });
    // The answer points at none of the tree's controls: a second look.
    await router.ground({ observation: { ...observation(), tree }, description: "the blue button", budget: BUDGET });
    assert.deepEqual(stub.asked, ["local:8000:ui-venus", "local:8000:ui-venus", "local:8000:ui-venus", "openrouter.ai:google/gemini-3.8-flash"]);
  } finally {
    stub.restore();
  }
});

test("a model that breaks its JSON twice hands the question to the one kept for second looks", async () => {
  // A string never closed, both times: asked a third time, it would break it a third time.
  const asked: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const { model } = JSON.parse(init.body) as { model: string };
    asked.push(model);
    const content = model === "haiku" ? '{"pass": true, "reason": "the button is there}' : '{"pass": true, "reason": "the button is there"}';
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  try {
    const cheap = { baseUrl: "https://openrouter.ai/api/v1", model: "haiku" };
    const mixed = new Router({ tiers: { ground: cheap, reason: cheap, escalation: { ...cheap, model: "sonnet" } } });
    const result = await mixed.assert({ observation: observation(), assertion: "the button is there" });
    assert.deepEqual(asked, ["haiku", "haiku", "sonnet"]);
    assert.equal(result.pass, true);
    assert.equal(result.provenance.model, "sonnet");
    // With no other model the answer stays unusable, and the run is told so.
    asked.length = 0;
    await assert.rejects(new Router({ tiers: { ground: cheap } }).assert({ observation: observation(), assertion: "the button is there" }), /could not parse the model's JSON/);
    assert.deepEqual(asked, ["haiku", "haiku"]);
  } finally {
    globalThis.fetch = original;
  }
});

/** Sends each call to `glm` where told; any other model answers. */
function stubGlm(glm: () => Response, other?: () => Response): { asked: string[]; restore: () => void } {
  const asked: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const { model } = JSON.parse(init.body) as { model: string };
    asked.push(model);
    if (model === "glm") return glm();
    if (other) return other();
    const content = '{"pass": true, "reason": "the button is there"}';
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { asked, restore: () => { globalThis.fetch = original; } };
}

const silence = (): Response => {
  throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
};
const GLM = { baseUrl: "https://openrouter.ai/api/v1", model: "glm" };
const MIXED = { tiers: { ground: GLM, reason: GLM, escalation: { ...GLM, model: "qwen" } } };
const QUESTION = { observation: observation(), assertion: "the button is there" };

test("what a model answered is kept word for word", async () => {
  const stub = stubGlm(() => new Response(JSON.stringify({ choices: [{ message: { content: 'First {"pass": true, "reason": "the button is there"}' }, finish_reason: "stop" }] }), { status: 200 }));
  try {
    const router = new Router(MIXED);
    await router.assert(QUESTION);
    assert.equal(router.ledger.all().at(-1)!.answer, 'First {"pass": true, "reason": "the button is there"}');
  } finally {
    stub.restore();
  }
});

test("a model that does not answer hands the question to the one kept for second looks", async () => {
  const stub = stubGlm(silence);
  try {
    const result = await new Router(MIXED).assert(QUESTION);
    // The client's own second ask, then no more of that wait: a third would be two minutes gone.
    assert.deepEqual(stub.asked, ["glm", "glm", "qwen"]);
    assert.equal(result.pass, true);
    assert.equal(result.provenance.model, "qwen");
  } finally {
    stub.restore();
  }
});

test("a model that answers with nothing to read hands the question on the same way", async () => {
  const cases: [string, () => Response][] = [
    ["a server error", () => new Response("upstream failed", { status: 500 })],
    ["out of room", () => new Response(JSON.stringify({ choices: [{ message: { content: '{"pass": true' }, finish_reason: "length" }] }), { status: 200 })],
    ["no content", () => new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 })],
  ];
  for (const [what, reply] of cases) {
    const stub = stubGlm(reply);
    try {
      assert.equal((await new Router(MIXED).assert(QUESTION)).provenance.model, "qwen", what);
      assert.deepEqual(stub.asked, ["glm", "qwen"], what);
    } finally {
      stub.restore();
    }
  }
});

test("with no other model to ask, silence is the error it was", async () => {
  const stub = stubGlm(silence);
  try {
    await assert.rejects(new Router({ tiers: { ground: GLM } }).assert(QUESTION), /glm at .* did not answer/);
    assert.deepEqual(stub.asked, ["glm", "glm"]);
  } finally {
    stub.restore();
  }
});

test("when the second model is silent too, the run is told", async () => {
  const stub = stubGlm(silence, silence);
  try {
    await assert.rejects(new Router(MIXED).assert(QUESTION), /qwen at .* did not answer/);
    assert.deepEqual(stub.asked, ["glm", "glm", "qwen", "qwen"]);
  } finally {
    stub.restore();
  }
});

test("a refused call is a mistake in the set-up, and another model does not hide it", async () => {
  const stub = stubGlm(() => new Response("no such model", { status: 404 }));
  try {
    await assert.rejects(new Router(MIXED).assert(QUESTION), /glm returned 404/);
    assert.deepEqual(stub.asked, ["glm"]);
  } finally {
    stub.restore();
  }
});
