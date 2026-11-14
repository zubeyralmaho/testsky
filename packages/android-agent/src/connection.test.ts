import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer, connect, type Server, type Socket } from "node:net";
import test from "node:test";

import { AGENT_JAR, AGENT_VERSION } from "./agent.ts";
import { AgentConnection, AgentError, AgentGoneError } from "./connection.ts";

/** A pretend agent: answers each line with whatever `answer` says, written in the pieces it says. */
async function fakeAgent(answer: (line: string) => Buffer[] | undefined): Promise<{ server: Server; client: AgentConnection; lines: string[] }> {
  const lines: string[] = [];
  const server = createServer((socket: Socket) => {
    let pending = "";
    socket.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        lines.push(line);
        const pieces = answer(line);
        if (!pieces) continue;
        pieces.forEach((piece, index) => setTimeout(() => socket.write(piece), index * 5));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const socket = connect(port, "127.0.0.1");
  await new Promise((resolve) => socket.once("connect", resolve));
  return { server, client: new AgentConnection(socket), lines };
}

const ok = (body: Buffer | string): Buffer => {
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  return Buffer.concat([Buffer.from(`ok ${bytes.length}\n`), bytes]);
};

test("an answer is read whole however it arrives, binary bodies included, and requests are answered in the order made", async () => {
  const picture = Buffer.from([0xff, 0xd8, 0x0a, 0x0a, 0x00, 0x6f, 0x6b, 0x20, 0x31, 0x0a, 0xff, 0xd9]);
  const { server, client, lines } = await fakeAgent((line) => {
    if (line === "shot 1 85") {
      const whole = ok(picture);
      return [whole.subarray(0, 3), whole.subarray(3, 9), whole.subarray(9)];
    }
    if (line === "ping") return [ok("pong")];
    return [Buffer.from(`err IllegalArgumentException: unknown request: ${line}\n`)];
  });
  const [shot, pong] = await Promise.all([client.request("shot 1 85"), client.request("ping")]);
  assert.deepEqual(shot, picture);
  assert.equal(pong.toString(), "pong");
  assert.deepEqual(lines, ["shot 1 85", "ping"], "the second request waited for the first answer");
  await assert.rejects(client.request("fly"), (error: Error) => error instanceof AgentError && /unknown request: fly/.test(error.message));
  assert.equal((await client.request("ping")).toString(), "pong", "a refusal leaves the connection usable");
  client.destroy();
  server.close();
});

test("an answer that does not come in time ends the connection, so a late one is never read as the next one's", async () => {
  const { server, client } = await fakeAgent((line) => (line === "slow" ? undefined : [ok("pong")]));
  await assert.rejects(client.request("slow", 50), (error: Error) => error instanceof AgentGoneError && /did not answer "slow"/.test(error.message));
  assert.equal(client.open, false);
  await assert.rejects(client.request("ping"), AgentGoneError);
  server.close();
});

test("an agent that goes away fails what is waiting, and what comes after", async () => {
  const { server, client } = await fakeAgent(() => undefined);
  const waiting = client.request("tree");
  server.close();
  for (const socket of await new Promise<Socket[]>((resolve) => server.getConnections(() => resolve([])))) socket.destroy();
  client.destroy();
  await assert.rejects(waiting, AgentGoneError);
  await assert.rejects(client.request("ping"), AgentGoneError);
});

test("a request is one line", async () => {
  const { server, client } = await fakeAgent(() => [ok("pong")]);
  await assert.rejects(client.request("type a\nquit"), AgentError);
  client.destroy();
  server.close();
});

test("the jar is in the repository, and the host expects the version its source says", () => {
  assert.ok(existsSync(AGENT_JAR), `${AGENT_JAR} is missing: run packages/android-agent/build.sh`);
  const source = readFileSync(new URL("../java/dev/testsky/agent/Main.java", import.meta.url), "utf8");
  assert.equal(/static final String VERSION = "([^"]+)"/.exec(source)?.[1], AGENT_VERSION);
});
