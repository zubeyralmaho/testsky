import assert from "node:assert/strict";
import test from "node:test";

import { allowedHosts, ConfigError, routerConfigFromYaml } from "./config.ts";

const YAML = `
offline: true
tiers:
  ground:
    base_url: http://vllm-grounder.internal:8000/v1/
    model: inclusionAI/UI-Venus-1.5-8B
    api_key_env: TESTSKY_GROUND_KEY
    timeout_ms: 8000
  reason:
    base_url: https://gateway.example.com/v1
    model: gemini-3-flash
    price_in_per_m: 0.75
    price_out_per_m: 3.75
  triage:
    enabled: false
    base_url: https://gateway.example.com/v1
    model: claude-sonnet
limits:
  max_usd_per_test: 0.25
`;

test("a models.yaml describes the ladder, and the key is named rather than written down", () => {
  process.env.TESTSKY_GROUND_KEY = "secret-from-the-environment";
  try {
    const config = routerConfigFromYaml(YAML);
    assert.equal(config.tiers.ground.model, "inclusionAI/UI-Venus-1.5-8B");
    // Trailing slash removed, because every call appends its own path.
    assert.equal(config.tiers.ground.baseUrl, "http://vllm-grounder.internal:8000/v1");
    assert.equal(config.tiers.ground.apiKey, "secret-from-the-environment");
    assert.equal(config.tiers.reason?.model, "gemini-3-flash");
    assert.equal(config.tiers.reason?.priceInPerM, 0.75);
    assert.equal(config.offline, true);
    assert.equal(config.limits?.maxUsdPerTest, 0.25);
    // A tier switched off is not half-configured; it is absent.
    assert.equal(config.tiers.triage, undefined);
  } finally {
    delete process.env.TESTSKY_GROUND_KEY;
  }
});

test("a file without a grounder is a configuration error, named in words", () => {
  assert.throws(() => routerConfigFromYaml("tiers:\n  reason:\n    model: x\n"), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /tiers\.ground/);
    return true;
  });
});

test("the allowed hosts are exactly the configured endpoints -- that is the offline promise", () => {
  process.env.TESTSKY_GROUND_KEY = "k";
  try {
    const hosts = allowedHosts(routerConfigFromYaml(YAML));
    assert.deepEqual(hosts.sort(), ["gateway.example.com", "vllm-grounder.internal:8000"]);
  } finally {
    delete process.env.TESTSKY_GROUND_KEY;
  }
});

test("beside a Midscene install, the runner asks Midscene's model with Midscene's key", async () => {
  const { routerConfigFromEnv } = await import("./config.ts");
  const keep = { ...process.env };
  try {
    for (const name of Object.keys(process.env)) if (/^(TESTSKY_|MIDSCENE_)/.test(name)) delete process.env[name];
    process.env.TESTSKY_MODELS_FILE = "/nonexistent/models.yaml";
    process.env.MIDSCENE_MODEL_BASE_URL = "https://openrouter.ai/api/v1/";
    process.env.MIDSCENE_MODEL_NAME = "qwen/qwen3-vl-235b-a22b-instruct";
    process.env.MIDSCENE_MODEL_API_KEY = "from-midscene";
    const config = routerConfigFromEnv();
    assert.equal(config.tiers.ground.baseUrl, "https://openrouter.ai/api/v1");
    assert.equal(config.tiers.ground.model, "qwen/qwen3-vl-235b-a22b-instruct");
    assert.equal(config.tiers.ground.apiKey, "from-midscene");

    process.env.TESTSKY_MODEL_BASE_URL = "https://own.example.com/v1";
    process.env.TESTSKY_MODEL_NAME = "own-model";
    assert.equal(routerConfigFromEnv().tiers.ground.model, "own-model", "testsky's own settings come first");
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in keep)) delete process.env[name];
    Object.assign(process.env, keep);
  }
});

test("a models.yaml can keep a better model for the second look alone", () => {
  process.env.TESTSKY_RIG_KEY = "from-the-environment";
  try {
    const config = routerConfigFromYaml(`
tiers:
  ground:
    base_url: https://openrouter.ai/api/v1
    model: qwen/qwen3-vl-235b-a22b-instruct
    api_key_env: TESTSKY_RIG_KEY
    price_in_per_m: 0.21
    price_out_per_m: 1.9
  escalation:
    base_url: https://openrouter.ai/api/v1
    model: google/gemini-3.8-flash
    api_key_env: TESTSKY_RIG_KEY
`);
    assert.equal(config.tiers.escalation?.model, "google/gemini-3.8-flash");
    assert.equal(config.tiers.escalation?.apiKey, "from-the-environment");
    assert.equal(config.tiers.reason, undefined, "planning and judging stay on the model asked every time");
    assert.equal(config.tiers.ground.priceInPerM, 0.21);
  } finally {
    delete process.env.TESTSKY_RIG_KEY;
  }
});

test("a models.yaml can say a gateway wants max_tokens and no temperature", () => {
  const config = routerConfigFromYaml(`
tiers:
  ground:
    base_url: https://gateway.example.com/v1/
    model: claude-haiku-4-5
    max_tokens: 64000
    temperature: false
  reason:
    base_url: https://openrouter.ai/api/v1
    model: anthropic/claude-sonnet-5.5
`);
  assert.equal(config.tiers.ground.maxTokens, 64000);
  assert.equal(config.tiers.ground.temperature, false);
  assert.equal(config.tiers.reason?.maxTokens, undefined);
  assert.equal(config.tiers.reason?.temperature, undefined);
});

test("a models.yaml can keep a model on its cheapest OpenRouter host", () => {
  const config = routerConfigFromYaml(`
tiers:
  ground:
    base_url: https://openrouter.ai/api/v1
    model: z-ai/glm-5.3-flash
    provider:
      sort: price
`);
  assert.deepEqual(config.tiers.ground.provider, { sort: "price" });
});

test("a models.yaml can ask OpenRouter to send back the thinking a model does", () => {
  const config = routerConfigFromYaml(`
tiers:
  ground:
    base_url: https://openrouter.ai/api/v1
    model: anthropic/claude-haiku-5.5
    reasoning:
      enabled: true
  reason:
    base_url: https://openrouter.ai/api/v1
    model: anthropic/claude-haiku-5.5
`);
  assert.deepEqual(config.tiers.ground.reasoning, { enabled: true });
  assert.equal(config.tiers.reason?.reasoning, undefined, "nothing is asked for that the file does not say");
});
