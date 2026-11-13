import assert from "node:assert/strict";
import test from "node:test";

import { quietly } from "./quiet.ts";

test("quiet calls that overlap give the streams back once the last of them ends, whichever ends first", async () => {
  const log = console.log;
  const write = process.stdout.write;
  let finishFirst!: () => void;
  const first = quietly(() => new Promise<void>((resolve) => (finishFirst = resolve)));
  let finishSecond!: () => void;
  const second = quietly(() => new Promise<void>((resolve) => (finishSecond = resolve)));
  assert.notEqual(console.log, log, "quiet while they run");
  finishFirst();
  await first;
  assert.notEqual(console.log, log, "still quiet: the second is still running");
  finishSecond();
  await second;
  assert.equal(console.log, log);
  assert.equal(process.stdout.write, write);
});
