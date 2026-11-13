import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";

import { acquireLease, deviceLeasePath, elapsed, leaseHolder, withFileLock } from "./lease.ts";

const LEASE = new URL("./lease.ts", import.meta.url).pathname;

async function place(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "testsky-lease-")), "phone.lease");
}

/** Another process: it runs `body` with `acquireLease` and `withFileLock` in scope. */
function another(body: string, ...args: string[]): ChildProcess {
  const script = `import { acquireLease, withFileLock } from ${JSON.stringify(LEASE)};\n${body}`;
  return spawn(process.execPath, ["--input-type=module", "-e", script, "--", ...args], { stdio: ["ignore", "pipe", "inherit"] });
}

async function said(child: ChildProcess, word: string): Promise<void> {
  let out = "";
  for await (const chunk of child.stdout!) {
    out += String(chunk);
    if (out.includes(word)) return;
  }
  throw new Error(`the other process ended without saying "${word}"`);
}

const holder = (pid: number, started: number) => JSON.stringify({ pid, host: hostname(), started, since: new Date().toISOString(), what: "run wifi" });

test("a lease is one holder's: the next to ask is told who holds it, and gets it once it is let go", async () => {
  const path = await place();
  const first = await acquireLease(path, "run wifi-connect");
  assert.ok("lease" in first);
  const second = await acquireLease(path, "run wifi-forget");
  assert.ok("busy" in second);
  assert.equal(second.busy?.pid, process.pid);
  assert.equal(second.busy?.what, "run wifi-connect");
  await first.lease.release();
  assert.equal(existsSync(path), false);
  assert.ok("lease" in (await acquireLease(path)));
});

test("another process's lease holds while it lives, and is taken over once it is killed", async () => {
  const path = await place();
  const child = another(`const held = await acquireLease(process.argv[1], "run wifi-connect"); console.log("lease" in held ? "held" : "busy"); setInterval(() => {}, 1000);`, path);
  await said(child, "held");
  const busy = await acquireLease(path);
  assert.ok("busy" in busy);
  assert.equal(busy.busy?.pid, child.pid);
  child.kill("SIGKILL");
  await once(child, "exit");
  assert.equal(existsSync(path), true, "killed outright, it could not let go");
  const taken = await acquireLease(path);
  assert.ok("lease" in taken, "and a lease whose process is gone is free");
  await taken.lease.release();
});

test("a process that exits without letting go still does not hold the phone", async () => {
  const path = await place();
  const child = another(`await acquireLease(process.argv[1]); console.log("held"); process.exit(3);`, path);
  await said(child, "held");
  await once(child, "exit");
  assert.equal(existsSync(path), false);
});

test("a lease naming a live pid that a later process was given is not held by it", async () => {
  const path = await place();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await writeFile(path, holder(child.pid!, Date.parse("2026-01-01T00:00:00Z")));
    const taken = await acquireLease(path);
    assert.ok("lease" in taken);
    await taken.lease.release();
  } finally {
    child.kill("SIGKILL");
  }
});

test("a lease file with nothing readable in it is being written while young, and abandoned once old", async () => {
  const path = await place();
  await writeFile(path, "");
  const young = await acquireLease(path);
  assert.ok("busy" in young);
  assert.equal(young.busy, undefined);
  const old = new Date(Date.now() - 60_000);
  await utimes(path, old, old);
  assert.ok("lease" in (await acquireLease(path)));
});

test("writers in one process take turns", async () => {
  const path = await place();
  const counter = `${path}.count`;
  await writeFile(counter, "0");
  await Promise.all(
    Array.from({ length: 12 }, () =>
      withFileLock(path, async () => {
        const value = Number(await readFile(counter, "utf8"));
        await new Promise((resolve) => setTimeout(resolve, 2));
        await writeFile(counter, String(value + 1));
      }),
    ),
  );
  assert.equal(await readFile(counter, "utf8"), "12");
});

test("writers in several processes take turns", async () => {
  const path = await place();
  const counter = `${path}.count`;
  await writeFile(counter, "0");
  const body = `
    import { readFile, writeFile } from "node:fs/promises";
    const [lock, counter] = process.argv.slice(1);
    for (let i = 0; i < 15; i += 1) {
      await withFileLock(lock, async () => {
        const value = Number(await readFile(counter, "utf8"));
        await new Promise((resolve) => setTimeout(resolve, 1));
        await writeFile(counter, String(value + 1));
      });
    }`;
  const children = [1, 2, 3].map(() => another(body, path, counter));
  const codes = await Promise.all(children.map(async (child) => (await once(child, "exit"))[0] as number));
  assert.deepEqual(codes, [0, 0, 0]);
  assert.equal(await readFile(counter, "utf8"), "45");
});

test("a phone's lease is named for its platform and id, in characters any filesystem takes", () => {
  assert.equal(deviceLeasePath({ platform: "android", id: "192.168.1.5:5555" }, "/h"), "/h/devices/android-192.168.1.5_5555.lease");
  assert.equal(deviceLeasePath({ platform: "ios", id: "A1B2-C3" }, "/h"), "/h/devices/ios-A1B2-C3.lease");
  assert.equal(
    deviceLeasePath({ platform: "android", id: "192.168.1.5:5555", serial: "R58M1234" }, "/h"),
    "/h/devices/android-R58M1234.lease",
    "one phone on a cable and over the network is one lease",
  );
});

test("a lease written while the Mac had another name is judged by its process like any other", async () => {
  const path = await place();
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  await writeFile(path, JSON.stringify({ pid: child.pid, host: "old-name.local", started: Date.now(), since: new Date().toISOString() }));
  const taken = await acquireLease(path);
  assert.ok("lease" in taken, "its process is gone, so is its hold");
  await taken.lease.release();
});

test("how long a process has run is read the way ps prints it", () => {
  assert.equal(elapsed("  01:23\n"), 83);
  assert.equal(elapsed("02:01:23"), 7283);
  assert.equal(elapsed("3-02:01:23"), 3 * 86_400 + 7283);
  assert.equal(elapsed("Mon Oct 26"), undefined);
});

test("who holds a lease can be asked without taking it", async () => {
  const path = await place();
  assert.equal(await leaseHolder(path), undefined, "nobody yet");
  const held = await acquireLease(path, "run wifi-connect");
  assert.ok("lease" in held);
  assert.equal((await leaseHolder(path))?.what, "run wifi-connect");
  assert.ok("busy" in (await acquireLease(path)), "and asking did not take it");
  await held.lease.release();
  const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(gone, "exit");
  await writeFile(path, holder(gone.pid!, Date.now()));
  assert.equal(await leaseHolder(path), undefined, "a holder that is gone holds nothing");
});
