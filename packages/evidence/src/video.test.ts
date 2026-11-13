import assert from "node:assert/strict";
import test from "node:test";

import { selfLimiting } from "./video.ts";

const exited = (child: ReturnType<typeof selfLimiting>, withinMs: number) =>
  new Promise<boolean>((resolve) => {
    if (child.exitCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), withinMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

/** The processes whose command line holds `pattern`, as pgrep lists them. */
const running = async (pattern: string) => {
  const { execFile } = await import("node:child_process");
  return new Promise<string>((resolve) => execFile("pgrep", ["-fl", pattern], (_error, stdout) => resolve(String(stdout).trim())));
};

test("a recorder nobody stops stops itself at its limit", { timeout: 20_000 }, async () => {
  const child = selfLimiting("sleep", ["601"], 1);
  assert.equal(await exited(child, 15_000), true, "a forgotten recorder does not run for weeks");
});

/** Until the shell has handed its place to the recorder: an interrupt before that is the shell's. */
const recording = async (child: ReturnType<typeof selfLimiting>, length: string) => {
  const { execFile } = await import("node:child_process");
  for (let i = 0; i < 100; i += 1) {
    const command = await new Promise<string>((resolve) =>
      execFile("ps", ["-p", String(child.pid), "-o", "command="], (_error, stdout) => resolve(String(stdout).trim())),
    );
    if (command === `sleep ${length}`) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

test("an interrupt is passed on, so the recorder can finish its file and go -- and its timer with it", { timeout: 20_000 }, async () => {
  // A length no command line here spells out, so only this recorder matches it.
  const length = String(1000 + Math.floor(Math.random() * 9000));
  const child = selfLimiting("sleep", [length], 600);
  await recording(child, length);
  child.kill("SIGINT");
  assert.equal(await exited(child, 5000), true);
  // The timer looks once a second; a loaded machine may take a few.
  let left = "";
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    left = await running(`recorder sleep ${length}`);
    if (!left) break;
  }
  assert.equal(left, "", "nothing is left sleeping for ten minutes");
});
