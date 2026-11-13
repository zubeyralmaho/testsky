import assert from "node:assert/strict";
import test from "node:test";

import type { Anchor, Observation, TreeNode } from "@testsky/engine-core";
import { fixtureScreen, patchHash } from "@testsky/perception";

import { relocateAnchor, screenMatches, verifyAnchor } from "./verify.ts";

function node(partial: Partial<TreeNode> & { ref: string }): TreeNode {
  return { role: "View", bounds: { x: 0, y: 0, width: 100, height: 40 }, enabled: true, interactive: false, children: [], ...partial };
}

function withTree(children: TreeNode[]): Observation["tree"] {
  return {
    platform: "android",
    capturedAt: 0,
    source: "uiautomator",
    truncated: false,
    captureMs: 2000,
    root: node({ ref: "root", bounds: { x: 0, y: 0, width: 384, height: 832 }, children }),
  };
}

function observation(over: Partial<Observation> = {}): Observation {
  return {
    frame: { bytes: Buffer.alloc(0), capturedAt: 0, size: { width: 360, height: 720 }, pixelRatio: 3 },
    visionBlind: false,
    visionStats: { meanLuma: 100, stdLuma: 30, uniqueColors: 90 },
    signature: { phash: "0f0f0f0f0f0f0f0f", maskedRegions: [] },
    appContext: {},
    observedAt: Date.now(),
    ...over,
  };
}

const BUTTON = node({
  ref: "b",
  role: "Button",
  label: "Continue",
  identifier: "com.acme:id/next",
  bounds: { x: 60, y: 560, width: 240, height: 72 },
  interactive: true,
});

const ANCHOR: Anchor = {
  tree: { role: "Button", label: "Continue", identifier: "com.acme:id/next", bounds: { x: 60, y: 560, width: 240, height: 72 } },
};

test("the same control in the same place needs no model to confirm", async () => {
  const verdict = await verifyAnchor(ANCHOR, { x: 180, y: 596 }, observation({ tree: withTree([BUTTON]) }));
  assert.equal(verdict.ok, true);
  assert.equal(verdict.by, "tree");
});

test("a control that drifted a little is still the control", async () => {
  const moved = { ...BUTTON, bounds: { ...BUTTON.bounds, y: BUTTON.bounds.y + 12 } };
  const verdict = await verifyAnchor(ANCHOR, { x: 180, y: 600 }, observation({ tree: withTree([moved]) }));
  assert.equal(verdict.ok, true);
});

test("a rename is caught, and says what it is called now", async () => {
  const renamed = { ...BUTTON, label: "Devam et" };
  const verdict = await verifyAnchor(ANCHOR, { x: 180, y: 596 }, observation({ tree: withTree([renamed]) }));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /called "Devam et" now/);
});

test("a label of short words is still itself, and still caught when it changes", async () => {
  // The word overlap skips words of two letters or fewer, so on its own it
  // finds nothing in common between "OK" and "OK" -- and the step went back to
  // a model on every run for a button that had not changed.
  const anchor: Anchor = { tree: { role: "Button", label: "OK", bounds: BUTTON.bounds } };
  const at = { x: 180, y: 596 };
  const ok = node({ ref: "ok", role: "Button", label: "OK", bounds: BUTTON.bounds, interactive: true });

  const same = await verifyAnchor(anchor, at, observation({ tree: withTree([ok]) }));
  assert.equal(same.ok, true, same.reason);
  assert.equal(same.by, "tree");
  const recased = await verifyAnchor(anchor, at, observation({ tree: withTree([{ ...ok, label: " Ok " }]) }));
  assert.equal(recased.ok, true, recased.reason);

  const changed = await verifyAnchor(anchor, at, observation({ tree: withTree([{ ...ok, label: "No" }]) }));
  assert.equal(changed.ok, false);
  assert.match(changed.reason, /called "No" now/);
});

test("something else standing where the button was is caught", async () => {
  const other = node({ ref: "x", role: "ImageView", bounds: BUTTON.bounds, interactive: true });
  const verdict = await verifyAnchor(ANCHOR, { x: 180, y: 596 }, observation({ tree: withTree([other]) }));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /ImageView is there now/);
});

test("with no tree, the pixels around the point answer instead", async () => {
  const fixture = await fixtureScreen();
  const centre = { x: fixture.target.x + fixture.target.width / 2, y: fixture.target.y + fixture.target.height / 2 };
  const frame = { bytes: fixture.png, capturedAt: 0, size: fixture.size, pixelRatio: fixture.pixelRatio };
  const anchor: Anchor = { patchPhash: (await patchHash(fixture.png, centre, fixture))! };

  const same = await verifyAnchor(anchor, centre, observation({ frame }));
  assert.equal(same.ok, true);
  assert.equal(same.by, "pixels");

  // Aim at the same coordinates on a screen where that spot is now empty.
  const elsewhere = await verifyAnchor(anchor, { x: 180, y: 300 }, observation({ frame }));
  assert.equal(elsewhere.ok, false);
  assert.match(elsewhere.reason, /changed/);
});

test("nothing remembered, or nothing to check with, is a miss -- never a guess", async () => {
  assert.equal((await verifyAnchor(undefined, { x: 1, y: 1 }, observation())).ok, false);
  assert.equal((await verifyAnchor({}, { x: 1, y: 1 }, observation())).ok, false);
  // A blank screen cannot corroborate pixels, and there is no tree here.
  const blind = observation({ visionBlind: true });
  assert.equal((await verifyAnchor({ patchPhash: "ffffffffffffffff" }, { x: 1, y: 1 }, blind)).ok, false);
});

test("screen identity prefers the tree hash and falls back to the picture", () => {
  const obs = observation({ signature: { phash: "0f0f0f0f0f0f0f0f", treeHash: "abc123", maskedRegions: [] } });
  assert.equal(screenMatches({ phash: "ffffffffffffffff", treeHash: "abc123" }, obs), true, "same controls, repainted");
  assert.equal(screenMatches({ phash: "0f0f0f0f0f0f0f0f", treeHash: "different" }, obs), false);
  // Without tree hashes it is the picture, within a few bits.
  const noTree = observation();
  assert.equal(screenMatches({ phash: "0f0f0f0f0f0f0f0e" }, noTree), true);
  assert.equal(screenMatches({ phash: "ffffffffffffffff" }, noTree), false);
});

test("an anchor that fits any screen verifies nothing", async () => {
  // Both of these were found in a real lock file, and together they let a
  // staled point replay at tier 0 on a screen that had moved: the pixels
  // around the point were flat, so the hash matched another flat patch, and
  // the tree anchor was the window, which is under every point there is.
  const verdict = await verifyAnchor(
    {
      patchPhash: "0000000000000000",
      tree: { role: "Other", bounds: { x: 0, y: 0, width: 440, height: 956 } },
    },
    { x: 180, y: 400 },
    observation({ tree: withTree([BUTTON]) }),
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /identifies any screen/);
});

test("an empty memory says so, rather than that it matches everything", async () => {
  const verdict = await verifyAnchor({}, { x: 180, y: 596 }, observation({ tree: withTree([BUTTON]) }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "nothing was remembered about this target");
});


test("a control a scroll moved is found where it went -- one of it, the same words, in view", () => {
  const moved = node({ ...BUTTON, ref: "moved", bounds: { x: 60, y: 200, width: 240, height: 72 } });
  const at = { x: 180, y: 596 };
  assert.deepEqual(relocateAnchor(ANCHOR, at, observation({ tree: withTree([moved]) })), { x: 180, y: 236 }, "the same spot on the control");
  const twice = node({ ...BUTTON, ref: "again", bounds: { x: 60, y: 400, width: 240, height: 72 } });
  assert.equal(relocateAnchor(ANCHOR, at, observation({ tree: withTree([moved, twice]) })), undefined, "two of it is no answer");
  const renamed = node({ ...BUTTON, ref: "renamed", label: "Continue shopping", bounds: moved.bounds });
  assert.equal(relocateAnchor(ANCHOR, at, observation({ tree: withTree([renamed]) })), undefined, "other words are a change, for a person");
  const below = node({ ...BUTTON, ref: "below", bounds: { x: 60, y: 900, width: 240, height: 72 } });
  assert.equal(relocateAnchor(ANCHOR, at, observation({ tree: withTree([below]) })), undefined, "off the screen is nowhere to press");
  assert.equal(relocateAnchor({ patchPhash: "00ff00ff00ff00ff" }, at, observation({ tree: withTree([moved]) })), undefined, "pixels alone cannot be followed");
});
