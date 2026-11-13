import assert from "node:assert/strict";
import test from "node:test";

import { fixtureScreen, pointInside } from "./fixture.ts";
import { isVisionBlind, visionStats } from "./vision-stats.ts";

test("the fixture is a readable screen, not a blank one", async () => {
  const fixture = await fixtureScreen();
  assert.equal(isVisionBlind(await visionStats(fixture.png)), false);
});

test("the target sits inside the screen, and pointInside means what it says", async () => {
  const { target, size } = await fixtureScreen();
  assert.ok(target.x + target.width <= size.width);
  assert.ok(target.y + target.height <= size.height);

  const centre = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
  assert.equal(pointInside(centre, target), true);
  // A grounder that answered in image pixels instead of points lands far away,
  // which is exactly the mistake this check exists to catch.
  assert.equal(pointInside({ x: centre.x * 3, y: centre.y * 3 }, target), false);
  assert.equal(pointInside({ x: target.x - 20, y: centre.y }, target), false);
});
