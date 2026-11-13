import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import sharp from "sharp";

import { askVision, ModelError, parseJsonAnswer, reasoningOf } from "./client.ts";

test("reads the JSON a model actually returns, not the JSON we asked for", () => {
  assert.deepEqual(parseJsonAnswer('{"found": true, "point": [10, 20]}'), { found: true, point: [10, 20] });
  // Fenced, which every model does no matter what the prompt says.
  assert.deepEqual(parseJsonAnswer('```json\n{"pass": false}\n```'), { pass: false });
  // Wrapped in prose, which the smaller ones do.
  assert.deepEqual(parseJsonAnswer('Sure! Here it is: {"pass": true} Hope that helps.'), { pass: true });
});

test("an answer with no JSON at all is a model error, with the answer quoted", () => {
  assert.throws(() => parseJsonAnswer("I cannot see the screenshot."), (error: unknown) => {
    assert.ok(error instanceof ModelError);
    assert.match(error.message, /I cannot see the screenshot/);
    return true;
  });
  // Braces present but the contents are malformed -- a different branch, and
  // the message has to name the parser's complaint, not just shrug.
  assert.throws(() => parseJsonAnswer('{"broken": }'), /could not parse the model's JSON/);
  assert.throws(() => parseJsonAnswer('{"unclosed": 1'), /expected JSON, got/);
});

test("a quote left unescaped inside a string is read as the model meant it", () => {
  // Haiku 5.5 judging a YouTube search, twice in a row: the term quoted as the expectation quotes it.
  assert.deepEqual(
    parseJsonAnswer('{"pass": true, "reason": "The search field reads "4k video uzun" and YouTube video results for that query are listed below it."}'),
    { pass: true, reason: 'The search field reads "4k video uzun" and YouTube video results for that query are listed below it.' },
  );
  assert.deepEqual(parseJsonAnswer('{"pass": false, "reason": "it says "OK""}'), { pass: false, reason: 'it says "OK"' });
  // A line break inside a string, which JSON does not allow either.
  assert.deepEqual(parseJsonAnswer('{"pass": false, "reason": "two\nlines"}'), { pass: false, reason: "two\nlines" });
});

test("an answer given twice is read once, and two different answers are no answer", () => {
  // Haiku 5.5 finding the App Store's search tab, then "correcting" itself.
  const found = '{"found": true, "point": [826, 955], "box": [721, 906, 936, 970], "why": "Tab bar button labeled Arayın at bottom right."}';
  const note = "\n\nNote: the point should be on the 0-1000 scale, so the corrected answer is:\n\n";
  assert.deepEqual(parseJsonAnswer(`${found}${note}${found}`), JSON.parse(found));
  assert.throws(() => parseJsonAnswer(`${found}${note}{"found": true, "point": [322, 806], "why": "the search tab"}`), (error: unknown) => {
    assert.ok(error instanceof ModelError);
    assert.match(error.message, /2 different answers/);
    return true;
  });
  // Prose after the answer that has braces of its own is still prose.
  assert.deepEqual(parseJsonAnswer('{"pass": true} -- the {placeholder} text was ignored'), { pass: true });
  // Fenced twice is answered twice, not the first fence taken.
  assert.throws(() => parseJsonAnswer('```json\n{"pass": true}\n```\nCorrection:\n```json\n{"pass": false}\n```'), /2 different answers/);
});

test("an answer the model took back is not read because its correction could not be", () => {
  const retracted = '{"pass": true, "reason": "The Pay button is shown."}\nNote: it is greyed out, so the corrected answer is:\n{"pass": false, "reason": "The button reads "Pay", but it is greyed out."}';
  assert.throws(() => parseJsonAnswer(retracted), /could not parse the model's JSON/);
  // Nor is a string mended into a second "pass" that overrules the first.
  assert.throws(() => parseJsonAnswer('{"pass": false, "reason": "the row reads "x", "pass": true}'), /could not parse the model's JSON/);
});

test("a string the model never closed is not mended into something it did not say", () => {
  // Qwen3-VL planning an App Store search, twice in a row: "tap with its closing quote missing.
  const plan = '{\n  "doneWhen": null,\n  "last": "nothing",\n  "actions": [\n    {\n      "name": "tap,\n      "describeTarget": "the Search icon in the bottom nav bar",\n      "effect": "opens the search page"\n    }\n  ]\n}';
  assert.throws(() => parseJsonAnswer(plan), /could not parse the model's JSON/);
});

test("what a call cost is the host's own figure when it gives one, and OpenRouter is asked for it", async () => {
  const sent: Record<string, unknown>[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body) as Record<string, unknown>);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 10, cost: 0.000231 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  try {
    const { askVision } = await import("./client.ts");
    const openrouter = await askVision({ baseUrl: "https://openrouter.ai/api/v1", model: "qwen/qwen3-vl-235b-a22b-instruct", priceInPerM: 99 }, { system: "s", user: "u" }, 1);
    assert.equal(openrouter.provenance.usd, 0.000231, "the host's figure, not the configured price");
    assert.deepEqual(sent[0]!.usage, { include: true });
    const local = await askVision({ baseUrl: "http://127.0.0.1:8000/v1", model: "m", priceInPerM: 0.21, priceOutPerM: 1.9 }, { system: "s", user: "u" }, 1);
    assert.equal(sent[1]!.usage, undefined, "other hosts are not sent OpenRouter's parameter");
    assert.equal(local.provenance.usd, 0.000231, "a host's figure is taken from any host that gives one");
  } finally {
    globalThis.fetch = original;
  }
});

test("a call is not capped: the model's own output limit is the limit", async () => {
  const sent: Record<string, unknown>[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body) as Record<string, unknown>);
    return new Response(JSON.stringify({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  try {
    const { askVision } = await import("./client.ts");
    await askVision({ baseUrl: "http://h/v1", model: "thinker" }, { system: "s", user: "u" }, 2);
    assert.equal("max_tokens" in sent[0]!, false);
  } finally {
    globalThis.fetch = original;
  }
});

test("a gateway that will not answer without max_tokens is sent the model's own limit, and no temperature if it refuses one", async () => {
  const sent: Record<string, unknown>[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body) as Record<string, unknown>);
    return new Response(JSON.stringify({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  try {
    const { askVision } = await import("./client.ts");
    await askVision({ baseUrl: "https://gateway.example.com/v1", model: "claude-haiku-4-5", maxTokens: 64000, temperature: false }, { system: "s", user: "u", temperature: 0.3 }, 1);
    assert.equal(sent[0]!.max_tokens, 64000);
    assert.equal("temperature" in sent[0]!, false);
    await askVision({ baseUrl: "http://h/v1", model: "m" }, { system: "s", user: "u", temperature: 0.3 }, 1);
    assert.equal(sent[1]!.temperature, 0.3, "everywhere else, the question's own temperature");
  } finally {
    globalThis.fetch = original;
  }
});

test("a busy host is asked again when it says to, and a host that stays busy is a model error", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  const busyFor = (times: number) =>
    (async () => {
      calls += 1;
      if (calls <= times) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"pass": true}' }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
  try {
    const { askVision } = await import("./client.ts");
    globalThis.fetch = busyFor(2);
    const answer = await askVision({ baseUrl: "https://gateway.example.com/v1", model: "claude-haiku-4-5" }, { system: "s", user: "u" }, 1);
    assert.equal(answer.text, '{"pass": true}');
    assert.equal(calls, 3);

    calls = 0;
    globalThis.fetch = busyFor(100);
    await assert.rejects(askVision({ baseUrl: "https://gateway.example.com/v1", model: "claude-haiku-4-5" }, { system: "s", user: "u" }, 1), (error: unknown) => {
      assert.ok(error instanceof ModelError);
      assert.equal(error.status, 429);
      return true;
    });
    assert.equal(calls, 6, "six tries, then it is the host's answer");
  } finally {
    globalThis.fetch = original;
  }
});

test("OpenRouter is sent the provider preferences a tier names, and who served the call is kept", async () => {
  const sent: Record<string, unknown>[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body) as Record<string, unknown>);
    return new Response(JSON.stringify({ provider: "Relace", choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 4000, completion_tokens: 100, cost: 0.000125 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  try {
    const { askVision } = await import("./client.ts");
    const answer = await askVision({ baseUrl: "https://openrouter.ai/api/v1", model: "z-ai/glm-5.3-flash", provider: { sort: "price" } }, { system: "s", user: "u" }, 1);
    assert.deepEqual(sent[0]!.provider, { sort: "price" });
    assert.equal(answer.provenance.provider, "Relace");
    await askVision({ baseUrl: "http://127.0.0.1:8000/v1", model: "m", provider: { sort: "price" } }, { system: "s", user: "u" }, 1);
    assert.equal("provider" in sent[1]!, false, "another host is not sent OpenRouter's parameter");
  } finally {
    globalThis.fetch = original;
  }
});

test("a call that never answered is asked once more, and twice silent is a model error", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  const silentFor = (times: number) =>
    (async () => {
      calls += 1;
      if (calls <= times) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"pass": true}' }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
  try {
    const { askVision } = await import("./client.ts");
    globalThis.fetch = silentFor(1);
    assert.equal((await askVision({ baseUrl: "https://openrouter.ai/api/v1", model: "z-ai/glm-5.3-flash" }, { system: "s", user: "u" }, 1)).text, '{"pass": true}');
    assert.equal(calls, 2);
    calls = 0;
    globalThis.fetch = silentFor(5);
    await assert.rejects(askVision({ baseUrl: "https://openrouter.ai/api/v1", model: "z-ai/glm-5.3-flash" }, { system: "s", user: "u" }, 1), /did not answer: The operation was aborted due to timeout/);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test("an answer whose body never came is asked once more: the body is part of the call", async () => {
  // OpenRouter sends its headers at once and the body when a host has answered; a slow host runs out the time mid-body.
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      const stalled = new ReadableStream({
        start(controller) {
          controller.error(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
        },
      });
      return new Response(stalled, { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"pass": true}' }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  try {
    const { askVision } = await import("./client.ts");
    const answer = await askVision({ baseUrl: "https://openrouter.ai/api/v1", model: "z-ai/glm-5.3-flash" }, { system: "s", user: "u" }, 1);
    assert.equal(answer.text, '{"pass": true}');
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test("a frame goes as a JPEG of the same size, however small, and what is not a picture as it came", async () => {
  const sent: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const { messages } = JSON.parse(init.body) as { messages: { content: { image_url?: { url: string } }[] }[] };
    sent.push(messages.at(-1)!.content.find((part) => part.image_url)!.image_url!.url);
    return new Response(JSON.stringify({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }), { status: 200 });
  }) as typeof globalThis.fetch;
  try {
    const big = await sharp(randomBytes(1300 * 1300 * 3), { raw: { width: 1300, height: 1300, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
    assert.ok(big.length * (4 / 3) > 5_000_000, "as a PNG it is over the limit");
    const small = await sharp({ create: { width: 40, height: 80, channels: 3, background: "#ffffff" } }).png().toBuffer();
    const notAPicture = Buffer.from("not a frame");
    const cfg = { baseUrl: "http://h/v1", model: "m" };
    await askVision(cfg, { system: "s", user: "u", image: big }, 1);
    await askVision(cfg, { system: "s", user: "u", image: small }, 1);
    await askVision(cfg, { system: "s", user: "u", image: notAPicture }, 1);
    assert.match(sent[0]!, /^data:image\/jpeg;base64,/);
    assert.ok(sent[0]!.length < 5_000_000, `${sent[0]!.length} characters`);
    assert.equal((await sharp(Buffer.from(sent[0]!.split(",")[1]!, "base64")).metadata()).width, 1300, "the same frame: a point on it is still a point on the screen");
    assert.match(sent[1]!, /^data:image\/jpeg;base64,/);
    assert.equal(sent[2], `data:image/png;base64,${notAPicture.toString("base64")}`);
  } finally {
    globalThis.fetch = original;
  }
});

test("the thinking a host sends back is kept, wherever that host puts it", () => {
  assert.equal(reasoningOf({ content: "{}", reasoning: "OpenRouter's" }), "OpenRouter's");
  assert.equal(reasoningOf({ content: "{}", reasoning_content: "vLLM's" }), "vLLM's");
  assert.equal(
    reasoningOf({ content: "{}", reasoning: "all of it", reasoning_details: [{ text: "all of it" }] }),
    "all of it",
    "said once and again in parts is said once",
  );
  assert.equal(reasoningOf({ content: "{}", reasoning_details: [{ summary: "a summary" }, { text: "and the rest" }] }), "a summary\n\nand the rest");
  assert.equal(reasoningOf({ content: '<think>\nlet me look\n</think>\n{"pass": true}' }), "let me look", "a host that leaves it in the answer");
  assert.equal(reasoningOf({ content: "{}" }), undefined);
  assert.equal(reasoningOf({ content: "{}", reasoning: "  " }), undefined);
  assert.equal(reasoningOf(undefined), undefined);
});

test("an answer comes back with the thinking before it, when the host sends that", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: '{"pass": true}', reasoning: "looked twice" }, finish_reason: "stop" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof globalThis.fetch;
  try {
    const answer = await askVision({ baseUrl: "http://h/v1", model: "thinker" }, { system: "s", user: "u" }, 1);
    assert.equal(answer.text, '{"pass": true}');
    assert.equal(answer.reasoning, "looked twice");
  } finally {
    globalThis.fetch = original;
  }
});
