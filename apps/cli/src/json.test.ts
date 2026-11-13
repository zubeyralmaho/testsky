import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const JSON_TS = new URL("./json.ts", import.meta.url).href;

/** A process that answers `--json`, says things along the way, and ends: what reaches each stream. */
function answering(body: string) {
  const script = `import { JsonAnswer } from ${JSON.stringify(JSON_TS)};\nconst json = new JsonAnswer();\n${body}`;
  const ran = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  return { stdout: ran.stdout, stderr: ran.stderr };
}

test("stdout holds the answer and nothing else; what a person reads goes to stderr", () => {
  const { stdout, stderr } = answering(`
console.log("  -> tap the cart icon");
process.stdout.write("dbug ADB a device library writing to stdout\\n");
json.answer({ outcome: "PASS", exitCode: 0 });
json.answer({ outcome: "FAIL_ASSERT" });
json.end(0);
`);
  assert.deepEqual(stdout.trim().split("\n").map((line) => JSON.parse(line)), [{ outcome: "PASS", exitCode: 0 }], "one object, the first");
  assert.match(stderr, /-> tap the cart icon/);
  assert.match(stderr, /a device library writing to stdout/);
});

test("a command refused before it has an answer is answered with its code and the last thing it said", () => {
  const { stdout } = answering(`
console.error("\\u001b[31mthe android device R58M is in use by run checkout (pid 4242)\\u001b[0m");
console.error("one run per phone at a time. If that run is gone, delete it");
json.end(2);
`);
  assert.deepEqual(JSON.parse(stdout), { outcome: "ERROR", exitCode: 2, detail: "one run per phone at a time. If that run is gone, delete it" });
});
