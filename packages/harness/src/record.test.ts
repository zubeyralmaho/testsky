import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { RunRecord } from "./record.ts";

const AT = Date.parse("2026-10-26T10:00:00.000Z");

test("a run's folder is named for when it started, the test and the phone", async () => {
  const root = await mkdtemp(join(tmpdir(), "testsky-runs-"));
  const record = new RunRecord(root, "wifi-connect", AT, "192.168.1.5:5555");
  await record.open({});
  assert.equal(basename(record.dir), "2026-10-26T10-00-00-000Z-wifi-connect-192.168.1.5_5555");
});

test("two runs of one test on one phone in the same millisecond get a folder each", async () => {
  const root = await mkdtemp(join(tmpdir(), "testsky-runs-"));
  const records = [new RunRecord(root, "wifi-connect", AT, "R58M"), new RunRecord(root, "wifi-connect", AT, "R58M")];
  await Promise.all(records.map((record) => record.open({})));
  assert.notEqual(records[0]!.dir, records[1]!.dir);
  assert.equal((await readdir(root)).length, 2);
});
