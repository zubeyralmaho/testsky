import assert from "node:assert/strict";
import test from "node:test";

import { statusBarOwner } from "./simctl.ts";

const LISTED = "Current Status Bar Overrides:\n=============================\n";

test("the status bar is ours only while our clock is all there is on it", () => {
  assert.equal(statusBarOwner(LISTED), "none");
  assert.equal(statusBarOwner(`${LISTED}Time: 09:41\n`), "ours", "as simctl prints --time 9:41 back");
  assert.equal(statusBarOwner(`${LISTED}Time: 9:41\n`), "ours");
  assert.equal(statusBarOwner(`${LISTED}Time: 10:09\n`), "theirs");
  assert.equal(statusBarOwner(`${LISTED}Time: 09:41\nDataNetworkType: wifi\n`), "theirs", "somebody added to it");
  assert.equal(statusBarOwner(""), "none", "a list that could not be read clears nothing");
});
