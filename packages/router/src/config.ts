/**
 * Which model answers what, and what it is allowed to talk to.
 *
 * One rule, enforced structurally rather than documented: the router is the
 * only module that constructs a model client. Everything else asks the router.
 * That is what keeps the tier ladder honest -- a grounder that quietly calls a
 * frontier model, or an executor that calls one mid-loop, makes the per-step
 * cost unexplainable, and explaining the per-step cost is a thing we sell.
 *
 * Configuration lives with the runner and never in the control plane: a
 * customer's API key that reaches our database is a liability we cannot
 * insure. It is read from ~/.testsky/models.yaml when that exists, and from
 * the environment otherwise, so a laptop needs no file and an air-gapped
 * installation needs no environment.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

export interface ModelConfig {
  /** An OpenAI-compatible base URL: a cloud gateway, or a local server. */
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** USD per 1M tokens, when the operator configured them. */
  priceInPerM?: number;
  priceOutPerM?: number;
  timeoutMs?: number;
  /**
   * Sent as max_tokens, only for a gateway that will not answer without one:
   * some refuse such a request. Set it to
   * the model's own output limit, never to the size of an answer -- a cap
   * sized for the answer cut off every model that thinks before it answers.
   */
  maxTokens?: number;
  /** False for a gateway that refuses a temperature of the caller's: none is sent. */
  temperature?: false;
  /**
   * OpenRouter's provider preferences, sent as they are written: `{sort:
   * price}` keeps a model on its cheapest host. Left to itself, OpenRouter
   * spread z-ai/glm-5.3-flash over hosts from $0.029 to $0.35 per million
   * input tokens, and 260 calls cost 3.5 times the catalogue price.
   */
  provider?: Record<string, unknown>;
}

/**
 * The ladder.
 *
 * `ground` answers "where is this element" and nothing else -- it is asked on
 * every cache miss, so it is the one worth running locally or cheaply.
 * `reason` judges expectations and decides what to do on an unexpected screen;
 * it is asked far less often and is worth a better model. `triage` reads the
 * wreckage of a failed run afterwards, never during one.
 */
export interface RouterConfig {
  tiers: {
    ground: ModelConfig;
    reason?: ModelConfig;
    /**
     * The second look, and only that: a target the model and the tree
     * disagreed about, and a pass that argued with itself. Asked rarely, so
     * it can be a better model than the one asked every time.
     */
    escalation?: ModelConfig;
    triage?: ModelConfig;
  };
  /** Refuse any host outside the configured base URLs. */
  offline?: boolean;
  limits?: { maxUsdPerTest?: number; maxUsdPerRun?: number };
}

export class ConfigError extends Error {}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function num(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function tierFromEnv(prefix: string, fallback?: ModelConfig): ModelConfig | undefined {
  const baseUrl = env(`${prefix}_BASE_URL`) ?? (prefix === "TESTSKY_MODEL" ? undefined : undefined);
  const model = env(`${prefix}_NAME`);
  if (!baseUrl || !model) return fallback;
  const config: ModelConfig = { baseUrl: baseUrl.replace(/\/+$/, ""), model };
  const apiKey = env(`${prefix}_API_KEY`) ?? env("TESTSKY_MODEL_API_KEY");
  if (apiKey) config.apiKey = apiKey;
  const inPrice = num(env(`${prefix}_PRICE_IN_PER_M`));
  if (inPrice !== undefined) config.priceInPerM = inPrice;
  const outPrice = num(env(`${prefix}_PRICE_OUT_PER_M`));
  if (outPrice !== undefined) config.priceOutPerM = outPrice;
  const timeout = num(env(`${prefix}_TIMEOUT_MS`));
  if (timeout !== undefined) config.timeoutMs = timeout;
  const maxTokens = num(env(`${prefix}_MAX_TOKENS`));
  if (maxTokens !== undefined) config.maxTokens = maxTokens;
  if (env(`${prefix}_TEMPERATURE`) === "false") config.temperature = false;
  return config;
}

interface YamlTier {
  base_url?: string;
  model?: string;
  api_key_env?: string;
  price_in_per_m?: number;
  price_out_per_m?: number;
  timeout_ms?: number;
  max_tokens?: number;
  temperature?: boolean;
  provider?: Record<string, unknown>;
  enabled?: boolean;
}

function tierFromYaml(raw: YamlTier | undefined): ModelConfig | undefined {
  if (!raw || raw.enabled === false || !raw.base_url || !raw.model) return undefined;
  const config: ModelConfig = { baseUrl: raw.base_url.replace(/\/+$/, ""), model: raw.model };
  // The key is named, never written down: the file can be read by anyone with
  // the repository, the environment cannot.
  const key = raw.api_key_env ? process.env[raw.api_key_env] : undefined;
  if (key) config.apiKey = key;
  if (raw.price_in_per_m !== undefined) config.priceInPerM = raw.price_in_per_m;
  if (raw.price_out_per_m !== undefined) config.priceOutPerM = raw.price_out_per_m;
  if (raw.timeout_ms !== undefined) config.timeoutMs = raw.timeout_ms;
  if (raw.max_tokens !== undefined) config.maxTokens = raw.max_tokens;
  if (raw.temperature === false) config.temperature = false;
  if (raw.provider && typeof raw.provider === "object" && !Array.isArray(raw.provider)) config.provider = raw.provider;
  return config;
}

export function modelsFilePath(): string {
  if (process.env.TESTSKY_MODELS_FILE) return process.env.TESTSKY_MODELS_FILE;
  return join(homedir(), ".testsky", "models.yaml");
}

export function routerConfigFromYaml(source: string): RouterConfig {
  const doc = parseYaml(source) as {
    offline?: boolean;
    tiers?: { ground?: YamlTier; reason?: YamlTier; escalation?: YamlTier; triage?: YamlTier };
    limits?: { max_usd_per_test?: number; max_usd_per_run?: number };
  } | null;
  const ground = tierFromYaml(doc?.tiers?.ground);
  if (!ground) throw new ConfigError("models.yaml has no usable tiers.ground (base_url and model are required)");
  const config: RouterConfig = { tiers: { ground } };
  const reason = tierFromYaml(doc?.tiers?.reason);
  if (reason) config.tiers.reason = reason;
  const escalation = tierFromYaml(doc?.tiers?.escalation);
  if (escalation) config.tiers.escalation = escalation;
  const triage = tierFromYaml(doc?.tiers?.triage);
  if (triage) config.tiers.triage = triage;
  if (doc?.offline) config.offline = true;
  const limits: RouterConfig["limits"] = {};
  if (doc?.limits?.max_usd_per_test !== undefined) limits.maxUsdPerTest = doc.limits.max_usd_per_test;
  if (doc?.limits?.max_usd_per_run !== undefined) limits.maxUsdPerRun = doc.limits.max_usd_per_run;
  if (Object.keys(limits).length) config.limits = limits;
  return config;
}

/**
 * The runner's model configuration: the file if there is one, the environment
 * otherwise.
 */
export function routerConfigFromEnv(): RouterConfig {
  const path = modelsFilePath();
  try {
    const source = readFileSync(path, "utf8");
    return routerConfigFromYaml(source);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    // No file is the normal case on a laptop; carry on with the environment.
  }

  const ground = tierFromEnv("TESTSKY_GROUND") ?? tierFromEnv("TESTSKY_MODEL") ?? midsceneTier();
  if (!ground) {
    throw new ConfigError(
      "No model configured. Either write " +
        modelsFilePath() +
        ", or set TESTSKY_MODEL_BASE_URL (an OpenAI-compatible endpoint) and TESTSKY_MODEL_NAME, " +
        "plus TESTSKY_MODEL_API_KEY unless the endpoint is open. Run `testsky doctor` to check the result.",
    );
  }
  const config: RouterConfig = { tiers: { ground } };
  const reason = tierFromEnv("TESTSKY_REASON");
  if (reason && (reason.baseUrl !== ground.baseUrl || reason.model !== ground.model)) config.tiers.reason = reason;
  const escalation = tierFromEnv("TESTSKY_ESCALATION");
  if (escalation && (escalation.baseUrl !== ground.baseUrl || escalation.model !== ground.model)) config.tiers.escalation = escalation;
  const triage = tierFromEnv("TESTSKY_TRIAGE");
  if (triage && (triage.baseUrl !== ground.baseUrl || triage.model !== ground.model)) config.tiers.triage = triage;
  if (env("TESTSKY_OFFLINE") === "true") config.offline = true;
  return config;
}

/**
 * The model a machine already set up for Midscene uses, read from Midscene's
 * own settings: a runner dropped beside a Midscene install asks the same
 * model, with the same key, and nobody copies a key anywhere to make it so.
 */
function midsceneTier(): ModelConfig | undefined {
  const baseUrl = env("MIDSCENE_MODEL_BASE_URL");
  const model = env("MIDSCENE_MODEL_NAME");
  if (!baseUrl || !model) return undefined;
  const config: ModelConfig = { baseUrl: baseUrl.replace(/\/+$/, ""), model };
  const apiKey = env("MIDSCENE_MODEL_API_KEY");
  if (apiKey) config.apiKey = apiKey;
  return config;
}

/** Every host this configuration is allowed to reach. */
export function allowedHosts(config: RouterConfig): string[] {
  return Object.values(config.tiers)
    .filter((tier): tier is ModelConfig => Boolean(tier))
    .map((tier) => new URL(tier.baseUrl).host);
}
