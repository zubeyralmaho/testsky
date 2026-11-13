import assert from "node:assert/strict";
import test from "node:test";

import type { Provenance } from "@testsky/engine-core";

import { CostLedger, pictureId } from "./ledger.ts";

const PROVENANCE: Provenance = { tier: 1, model: "m", usd: 0.001, latencyMs: 900, usedTree: true, channel: "fused" };

test("a call is kept with what it was asked, and a picture shown to many calls is kept once", () => {
  const ledger = new CostLedger();
  const picture = { id: pictureId(Buffer.from("a screen")), bytes: Buffer.from("a picture") };
  const user = 'Find "Pay".\n\nThe tree:\n[1] Button "Pay"\n\nAnswer exactly: {}';
  ledger.record("ground", PROVENANCE, "pay", '{"found": true}', { system: "you locate", user, tree: '[1] Button "Pay"', picture, reasoning: "one Pay button" });
  ledger.record("assert", PROVENANCE, "pay", '{"pass": true}', { system: "you judge", user: "is it paid?", picture });
  ledger.record("plan", { ...PROVENANCE, channel: "tree" }, "pay", "{}", { system: "you plan", user: "what next?" });
  const [ground, judge, plan] = ledger.all();

  assert.equal(ground!.asked?.user.slice(...ground!.asked!.treeSpan!), '[1] Button "Pay"');
  assert.equal(ground!.reasoning, "one Pay button");
  assert.equal(ground!.asked?.image, judge!.asked?.image);
  assert.equal(ledger.pictures.size, 1);
  assert.equal(plan!.asked?.image, undefined, "shown no picture");
  assert.equal(plan!.asked?.treeSpan, undefined);
  assert.equal(JSON.stringify(ledger.all()).includes("a picture"), false, "the picture is not in what is written out as JSON");

  const taken = ledger.takePictures([ground!]);
  assert.equal(ground!.asked?.image, picture.id, "known by the screen it was made from");
  assert.equal(taken.get(ground!.asked!.image!), picture.bytes);
  assert.equal(ledger.pictures.size, 0, "a reader that took them leaves none behind");
});

test("a tree that is not in the question is not pointed at", () => {
  const ledger = new CostLedger();
  ledger.record("assert", PROVENANCE, undefined, "{}", { system: "s", user: "no tree here", tree: "[1] Button" });
  assert.equal(ledger.all()[0]!.asked?.treeSpan, undefined);
});
