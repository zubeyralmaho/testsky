import assert from "node:assert/strict";
import test from "node:test";

import type { Observation, TreeNode } from "@testsky/engine-core";
import { fixtureScreen } from "@testsky/perception";
import { pictureId } from "./ledger.ts";
import { Router } from "./router.ts";
import { BlindScreenError } from "./router.ts";

function node(partial: Partial<TreeNode> & { ref: string }): TreeNode {
  return {
    role: "View",
    bounds: { x: 0, y: 0, width: 100, height: 40 },
    enabled: true,
    interactive: false,
    children: [],
    ...partial,
  };
}

/** A real image, because grounding now samples the pixels around its answer. */
const FRAME = (await fixtureScreen()).png;

function observation(over: Partial<Observation> = {}): Observation {
  return {
    frame: { bytes: FRAME, capturedAt: 0, size: { width: 360, height: 720 }, pixelRatio: 3 },
    visionBlind: false,
    visionStats: { meanLuma: 100, stdLuma: 30, uniqueColors: 90 },
    signature: { phash: "abc", maskedRegions: [] },
    appContext: {},
    observedAt: Date.now(),
    ...over,
  };
}

const TREE = {
  platform: "android" as const,
  capturedAt: 0,
  source: "uiautomator" as const,
  truncated: false,
  captureMs: 2400,
  root: node({
    ref: "root",
    bounds: { x: 0, y: 0, width: 384, height: 832 },
    children: [
      node({
        ref: "pin",
        role: "EditText",
        label: "PIN kodunu girin",
        identifier: "com.android.settings:id/password_entry",
        bounds: { x: 40, y: 400, width: 304, height: 56 },
        interactive: true,
      }),
    ],
  }),
};

/** Captures the request the router would send, and answers it. */
function stubModel(answer: unknown): { bodies: Record<string, unknown>[]; restore: () => void } {
  const bodies: Record<string, unknown>[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  return { bodies, restore: () => { globalThis.fetch = original; } };
}

function partsOf(body: Record<string, unknown>): { text: string; hasImage: boolean } {
  const messages = body.messages as { role: string; content: unknown }[];
  const user = messages.find((m) => m.role === "user")!;
  const content = user.content as string | { type: string; text?: string }[];
  if (typeof content === "string") return { text: content, hasImage: false };
  return {
    text: content.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
    hasImage: content.some((part) => part.type === "image_url"),
  };
}

const CONFIG = { tiers: { ground: { baseUrl: "http://stub/v1", model: "stub" } } };

test("a screen with no usable picture is judged from its tree, and no image is sent", async () => {
  const stub = stubModel({ pass: true, reason: "the PIN prompt is showing" });
  try {
    const router = new Router(CONFIG);
    const verdict = await router.assert({
      observation: observation({ visionBlind: true, tree: TREE }),
      assertion: "the screen asks for a PIN",
    });
    assert.equal(verdict.pass, true);

    const sent = partsOf(stub.bodies[0]!);
    assert.equal(sent.hasImage, false, "a blank picture must never be sent -- the model would describe it anyway");
    assert.match(sent.text, /PIN kodunu girin/, "the tree's labels are what it judges from");
    assert.match(sent.text, /no usable picture/);
    assert.equal(verdict.provenance.channel, "tree");
  } finally {
    stub.restore();
  }
});

test("an author who wrote channel: tree gets the tree, even when the picture is fine", async () => {
  const stub = stubModel({ pass: true, reason: "the field is there" });
  try {
    const router = new Router(CONFIG);
    await router.assert({
      observation: observation({ tree: TREE }),
      assertion: "a PIN field is visible",
      channel: "tree",
    });
    assert.equal(partsOf(stub.bodies[0]!).hasImage, false);
  } finally {
    stub.restore();
  }
});

test("with a picture, the tree comes along as corroboration rather than replacing it", async () => {
  const stub = stubModel({ found: true, point: [500, 500] });
  try {
    const router = new Router(CONFIG);
    await router.ground({
      observation: observation({ tree: TREE }),
      description: "the PIN field",
      budget: { maxUsd: 1, maxLatencyMs: 10_000, maxEscalations: 0 },
    });
    const sent = partsOf(stub.bodies[0]!);
    assert.equal(sent.hasImage, true);
    assert.match(sent.text, /PIN kodunu girin/);
  } finally {
    stub.restore();
  }
});

test("blank picture and no tree is refused, not guessed at", async () => {
  const router = new Router(CONFIG);
  await assert.rejects(
    () => router.assert({ observation: observation({ visionBlind: true }), assertion: "anything at all" }),
    BlindScreenError,
  );
});

test("grounding says what the model was shown, the box it drew and why", async () => {
  const stub = stubModel({ found: true, point: [500, 500], box: [400, 450, 600, 550], why: "the PIN entry field" });
  const budget = { maxUsd: 1, maxLatencyMs: 10_000, maxEscalations: 0 };
  try {
    const router = new Router(CONFIG);
    const withTree = await router.ground({ observation: observation({ tree: TREE }), description: "the PIN field", budget });
    assert.equal(withTree.provenance.channel, "fused", "a picture with the tree beside it is neither alone");
    assert.equal(withTree.provenance.usedTree, true);
    assert.equal(withTree.why, "the PIN entry field");
    assert.deepEqual(withTree.rect, { x: 144, y: 324, width: 72, height: 72 });

    const pictureOnly = await router.ground({ observation: observation(), description: "the PIN field", budget });
    assert.equal(pictureOnly.provenance.channel, "vision");
    assert.equal(pictureOnly.provenance.usedTree, false);
  } finally {
    stub.restore();
  }
});

/** A model that gives these answers, one per call, the last one again after that. */
function stubAnswers(...answers: unknown[]): { bodies: Record<string, unknown>[]; restore: () => void } {
  const stub = stubModel(answers[0]);
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    const answer = answers[Math.min(stub.bodies.length, answers.length - 1)];
    stub.bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  return { bodies: stub.bodies, restore: () => { globalThis.fetch = original; stub.restore(); } };
}

// The PIN field's centre, (192, 428) in points, on the 0-1000 scale a model answers in.
const ON_PIN = [533, 594];
const ELSEWHERE = [500, 100];
const BUDGET = { maxUsd: 1, maxLatencyMs: 10_000, maxEscalations: 1 };

test("the model and the tree on the same control: the tree measures it", async () => {
  const stub = stubAnswers({ found: true, point: [520, 600], why: "the PIN entry" });
  try {
    const found = await new Router(CONFIG).ground({ observation: observation({ tree: TREE }), description: "PIN kodunu girin", budget: BUDGET });
    assert.equal(stub.bodies.length, 1, "one model call");
    assert.equal(partsOf(stub.bodies[0]!).hasImage, true, "the model saw the picture");
    assert.match(partsOf(stub.bodies[0]!).text, /PIN kodunu girin/, "and the tree beside it");
    assert.equal(found.foundBy, "both");
    assert.deepEqual(found.point, { x: 192, y: 428 }, "the tree's centre, not the model's approximation");
    assert.deepEqual(found.rect, { x: 40, y: 400, width: 304, height: 56 });
    assert.equal(found.provenance.channel, "fused");
    assert.match(found.why ?? "", /the PIN entry; the tree agrees: the tree has one EditText called "PIN kodunu girin"/);
    assert.equal(found.anchor.tree?.label, "PIN kodunu girin", "and the memory can check it later");
  } finally {
    stub.restore();
  }
});

test("a model that looks and finds nothing outranks the tree: nothing is pressed", async () => {
  const stub = stubAnswers({ found: false, why: "a sheet covers the form" });
  try {
    await assert.rejects(
      () => new Router(CONFIG).ground({ observation: observation({ tree: TREE }), description: "PIN kodunu girin", budget: BUDGET }),
      /could not find "PIN kodunu girin" on this screen -- a sheet covers the form/,
    );
    assert.equal(stub.bodies.length, 1);
  } finally {
    stub.restore();
  }
});

test("the tree holds alone only with no picture to look at; a model that cannot answer fails the run", async () => {
  const garbled = stubAnswers("not json at all");
  try {
    await assert.rejects(
      () => new Router(CONFIG).ground({ observation: observation({ tree: TREE }), description: "PIN kodunu girin", budget: BUDGET }),
      (error: Error) => error.name === "ModelError",
      "not quietly left to the tree: a key that expired would never be noticed",
    );
  } finally {
    garbled.restore();
  }

  const blind = stubAnswers({ found: false });
  try {
    const found = await new Router(CONFIG).ground({
      observation: observation({ tree: TREE, visionBlind: true }),
      description: "PIN kodunu girin",
      budget: BUDGET,
    });
    assert.equal(found.foundBy, "tree", "the model read only the tree, which the tree read exactly");
    assert.match(found.why ?? "", /the model, reading the tree, found nothing/);
  } finally {
    blind.restore();
  }
});

test("...and the model, when the tree names nothing by itself", async () => {
  const stub = stubAnswers({ found: true, point: [500, 100], why: "the logo" });
  try {
    const found = await new Router(CONFIG).ground({ observation: observation({ tree: TREE }), description: "the logo", budget: { ...BUDGET, maxEscalations: 0 } });
    assert.equal(found.foundBy, "model");
    assert.deepEqual(found.point, { x: 180, y: 72 });
  } finally {
    stub.restore();
  }
});

test("a button at the very spot the tree would press is the control it named", async () => {
  // Google Play's sheet: a 48-point pressable View, the name on a node inside it, and a button inside that.
  const tree = {
    ...TREE,
    root: node({
      ref: "root",
      role: "FrameLayout",
      bounds: { x: 0, y: 0, width: 360, height: 720 },
      children: [
        node({
          ref: "press",
          role: "View",
          interactive: true,
          bounds: { x: 312, y: 300, width: 48, height: 48 },
          children: [
            node({
              ref: "name",
              role: "View",
              label: "Close",
              bounds: { x: 324, y: 312, width: 24, height: 24 },
              children: [node({ ref: "icon", role: "Button", bounds: { x: 324, y: 312, width: 24, height: 24 } })],
            }),
          ],
        }),
      ],
    }),
  };
  const stub = stubAnswers({ found: true, point: [933, 450], why: "the X at the top right" });
  try {
    const found = await new Router(CONFIG).ground({ observation: observation({ tree }), description: "Close", budget: BUDGET });
    assert.equal(stub.bodies.length, 1, "nothing to ask again");
    assert.equal(found.foundBy, "both");
    assert.deepEqual(found.point, { x: 336, y: 324 });
  } finally {
    stub.restore();
  }
});

test("disagreeing, the model is asked again, told where the tree's control is", async () => {
  const comesRound = stubAnswers({ found: true, point: ELSEWHERE }, { found: true, point: ON_PIN, why: "the field under the title" });
  try {
    const found = await new Router(CONFIG).ground({ observation: observation({ tree: TREE }), description: "PIN kodunu girin", budget: BUDGET });
    assert.equal(comesRound.bodies.length, 2);
    assert.match(partsOf(comesRound.bodies[1]!).text, /exactly one control called "PIN kodunu girin", at box \[111, 556, 956, 633\]/);
    assert.equal(found.foundBy, "both");
    assert.deepEqual(found.point, { x: 192, y: 428 });
  } finally {
    comesRound.restore();
  }

  const insists = stubAnswers({ found: true, point: ELSEWHERE, why: "the dialog's field" });
  try {
    await assert.rejects(
      () => new Router(CONFIG).ground({ observation: observation({ tree: TREE }), description: "PIN kodunu girin", budget: BUDGET }),
      (error: Error) =>
        error.name === "SourcesDisagreeError" &&
        /the model and the tree disagree about "PIN kodunu girin" -- the tree's EditText "PIN kodunu girin" is at \(40,400 304x56\), the model points at \(180,72\): the dialog's field; nothing was pressed/.test(error.message),
      "a tap on either would be a guess",
    );
    assert.equal(insists.bodies.length, 2);
  } finally {
    insists.restore();
  }

  const noBudget = stubAnswers({ found: true, point: ELSEWHERE });
  try {
    await assert.rejects(
      () => new Router(CONFIG).ground({ observation: observation({ tree: TREE }), description: "PIN kodunu girin", budget: { ...BUDGET, maxEscalations: 0 } }),
      /disagree/,
    );
    assert.equal(noBudget.bodies.length, 1, "without a second look to settle it, still nothing is pressed");
  } finally {
    noBudget.restore();
  }

  const gone = stubAnswers({ found: true, point: ELSEWHERE }, { found: false, why: "a sheet covers it" });
  try {
    await assert.rejects(
      () => new Router(CONFIG).ground({ observation: observation({ tree: TREE }), description: "PIN kodunu girin", budget: BUDGET }),
      /could not find/,
      "something over the tree's control: nothing is pressed, and the miss is replanned",
    );
  } finally {
    gone.restore();
  }
});

test("the tree measures what the model chose when their boxes are the same control", async () => {
  const stub = stubAnswers({ found: true, point: [300, 600], box: [100, 550, 950, 640], why: "the code entry box" });
  try {
    const found = await new Router(CONFIG).ground({ observation: observation({ tree: TREE }), description: "the box to type the code in", budget: BUDGET });
    assert.equal(stub.bodies.length, 1);
    assert.equal(found.foundBy, "both");
    assert.deepEqual(found.point, { x: 192, y: 428 });
    assert.deepEqual(found.rect, { x: 40, y: 400, width: 304, height: 56 });
    assert.match(found.why ?? "", /the tree measures it: EditText "PIN kodunu girin"/);
  } finally {
    stub.restore();
  }
});

test("a model pointing at none of the tree's controls gets a second look; a step that wants the picture is not held by the tree", async () => {
  const stub = stubAnswers({ found: true, point: ELSEWHERE }, { found: true, point: [520, 600] });
  try {
    const found = await new Router(CONFIG).ground({ observation: observation({ tree: TREE }), description: "the code field", budget: BUDGET });
    assert.equal(stub.bodies.length, 2);
    assert.deepEqual(found.point, { x: 187, y: 432 });
  } finally {
    stub.restore();
  }

  const vision = stubAnswers({ found: false });
  try {
    await assert.rejects(
      () =>
        new Router(CONFIG).ground({
          observation: observation({ tree: TREE }),
          description: "PIN kodunu girin",
          budget: BUDGET,
          hint: { preferChannel: "vision" },
        }),
      /could not find/,
      "the tree does not hold for a step that asked for the picture",
    );
  } finally {
    vision.restore();
  }
});

test("agreeing is being on the same control: a switch inside the row the tree named is another one", async () => {
  const row = node({
    ref: "row",
    role: "LinearLayout",
    bounds: { x: 0, y: 200, width: 360, height: 64 },
    interactive: true,
    children: [
      node({ ref: "label", role: "TextView", label: "Wi-Fi", bounds: { x: 16, y: 220, width: 200, height: 24 } }),
      node({ ref: "switch", role: "Switch", bounds: { x: 290, y: 212, width: 56, height: 40 }, interactive: true }),
    ],
  });
  const settings = { ...TREE, root: node({ ref: "root", bounds: { x: 0, y: 0, width: 360, height: 720 }, children: [row] }) };
  // The switch's centre, (318, 232), on the 0-1000 scale.
  const stub = stubAnswers({ found: true, point: [883, 322] });
  try {
    await assert.rejects(
      () => new Router(CONFIG).ground({ observation: observation({ tree: settings }), description: "Wi-Fi", budget: BUDGET }),
      /disagree/,
    );
    assert.equal(stub.bodies.length, 2, "asked again, told it was the row");
  } finally {
    stub.restore();
  }

  const onLabel = stubAnswers({ found: true, point: [200, 322] });
  try {
    const found = await new Router(CONFIG).ground({ observation: observation({ tree: settings }), description: "Wi-Fi", budget: BUDGET });
    assert.equal(found.foundBy, "both", "the label is on the row");
    assert.deepEqual(found.point, { x: 180, y: 232 });
  } finally {
    onLabel.restore();
  }
});

test("agreeing, the tap goes where the tree measures, unless the model's box leaves that out", async () => {
  const stub = stubAnswers({ found: true, point: [222, 569], box: [122, 558, 333, 583] });
  try {
    const found = await new Router(CONFIG).ground({ observation: observation({ tree: TREE }), description: "PIN kodunu girin", budget: BUDGET });
    assert.equal(found.foundBy, "both");
    assert.deepEqual(found.point, { x: 80, y: 410 }, "the centre is outside what the model saw of it, so the model's point");
    assert.deepEqual(found.rect, { x: 40, y: 400, width: 304, height: 56 });
  } finally {
    stub.restore();
  }
});

test("the judge is told a named page is open only when the screen's own heading names it", async () => {
  const stub = stubModel({ pass: false, reason: "the heading says Connections" });
  try {
    await new Router(CONFIG).assert({ observation: observation(), assertion: 'the Wi-Fi page is open, showing "HomeNet_A1B2"' });
    const messages = stub.bodies[0]!.messages as { role: string; content: unknown }[];
    const system = String(messages.find((message) => message.role === "system")?.content ?? "");
    assert.match(system, /is open only when the screen's own heading names it; a page that lists it, summarises it or shows its status in a row is another page/);
  } finally {
    stub.restore();
  }
});

test("a pass the tree disagrees with is looked at again, and the second look is told what the tree says", async () => {
  const stub = stubAnswers({ pass: true, reason: "the Wi-Fi section shows the network" }, { pass: false, reason: "the heading says Connections" });
  const connections = {
    ...TREE,
    root: node({
      ref: "root",
      bounds: { x: 0, y: 0, width: 360, height: 720 },
      children: [
        node({ ref: "h", role: "TextView", label: "Connections", bounds: { x: 60, y: 20, width: 120, height: 28 } }),
        node({ ref: "list", role: "RecyclerView", interactive: true, bounds: { x: 0, y: 60, width: 360, height: 660 }, children: [
          node({ ref: "t", role: "TextView", label: "Wi-Fi", bounds: { x: 20, y: 80, width: 60, height: 24 } }),
          node({ ref: "s", role: "TextView", label: "HomeNet_A1B2", bounds: { x: 20, y: 104, width: 160, height: 20 } }),
          node({ ref: "b", role: "TextView", label: "Bluetooth", bounds: { x: 20, y: 150, width: 90, height: 24 } }),
        ] }),
      ],
    }),
  };
  try {
    const result = await new Router({ tiers: { ...CONFIG.tiers, escalation: { baseUrl: "http://escalation/v1", model: "better" } } }).assert({
      observation: observation(),
      assertion: 'the Wi-Fi page is open, showing "HomeNet_A1B2"',
      evidenceTree: connections,
    });
    assert.equal(stub.bodies.length, 2);
    assert.equal(stub.bodies[1]!.model, "better", "the second look goes to the model kept for it");
    assert.match(partsOf(stub.bodies[1]!).text, /The screen's accessibility tree, read from the same screen, says: the screen's own heading reads "Connections", not "Wi-Fi"/);
    assert.doesNotMatch(partsOf(stub.bodies[0]!).text, /Connections/, "the judge itself is not shown the tree");
    assert.equal(result.pass, false);
    assert.deepEqual(result.evidence, ['the screen\'s own heading reads "Connections", not "Wi-Fi"']);
  } finally {
    stub.restore();
  }
});

test("an orientation is told to the judge from the frame's size, not left to the picture", async () => {
  const stub = stubAnswers({ pass: true, reason: "landscape" });
  try {
    await new Router(CONFIG).assert({ observation: observation(), assertion: "Settings is open in landscape" });
    assert.match(partsOf(stub.bodies[0]!).text, /the screen is 360 by 720 points, so it is in portrait/);
  } finally {
    stub.restore();
  }
});

test("each call is kept whole: the words it was sent, where the tree is in them, the picture and the thinking", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ found: true, point: [500, 500], why: "the PIN field" }), reasoning: "The tree has one field." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof globalThis.fetch;
  try {
    const router = new Router(CONFIG);
    const found = await router.ground({
      observation: observation({ tree: TREE }),
      description: "the PIN field",
      budget: { maxUsd: 1, maxLatencyMs: 10_000, maxEscalations: 0 },
    });
    const [call] = router.ledger.all();
    assert.equal(call!.reasoning, "The tree has one field.");
    assert.ok(call!.asked?.system.length, "the instructions it was given");
    const tree = call!.asked!.user.slice(...call!.asked!.treeSpan!);
    assert.match(tree, /PIN kodunu girin/);
    assert.doesNotMatch(tree, /Find this element/, "the tree's own lines, and nothing around them");
    assert.equal(call!.asked!.image, pictureId(FRAME), "the picture it was shown, known by the screen it came as");
    const kept = router.ledger.pictures.get(call!.asked!.image!)!;
    assert.deepEqual([kept[0], kept[1]], [0xff, 0xd8], "and kept small, as a JPEG");
    assert.equal(typeof found.treeSaid, "string", "and what the tree answered on its own");
  } finally {
    globalThis.fetch = original;
  }
});
