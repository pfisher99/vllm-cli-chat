import { promises as fs } from "node:fs";
import path from "node:path";

export const CONFIG_FILENAME = "vllm-cli-local-chat.config.json";
export const LEGACY_CONFIG_FILENAME = "local-chat.config.json";
export const CONFIG_PATH = path.join(process.cwd(), CONFIG_FILENAME);
const LEGACY_CONFIG_PATH = path.join(process.cwd(), LEGACY_CONFIG_FILENAME);

export const DEFAULT_CONFIG = {
  endpoint: "http://127.0.0.1:8000/v1/chat/completions",
  model: "Qwen3.5-9B-local",
  systemPrompt: [
    "You are a helpful assistant.",
    "When thinking is enabled, reason briefly and always provide a clear final answer.",
  ].join(" "),
  temperature: 1.0,
  topP: 0.95,
  topK: 20,
  minP: 0.0,
  maxTokens: 2048,
  presencePenalty: 1.5,
  repetitionPenalty: 1.0,
  frequencyPenalty: 0,
  enableThinking: true,
  stream: true,
  timeoutMs: 120000,
  seed: null,
};

function toBoolean(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "on", "yes", "y"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "off", "no", "n"].includes(normalized)) {
      return false;
    }
  }

  return fallback;
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toSeed(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeEndpoint(endpoint) {
  const raw = String(endpoint ?? DEFAULT_CONFIG.endpoint).trim();

  if (!raw) {
    return DEFAULT_CONFIG.endpoint;
  }

  if (raw.endsWith("/v1/chat/completions") || raw.includes("/chat/completions")) {
    return raw;
  }

  if (raw.endsWith("/v1")) {
    return `${raw}/chat/completions`;
  }

  if (raw.endsWith(":8000") || /^https?:\/\/[^/]+\/?$/.test(raw)) {
    return `${raw.replace(/\/+$/, "")}/v1/chat/completions`;
  }

  return raw;
}

export function normalizeConfig(value = {}) {
  return {
    endpoint: normalizeEndpoint(value.endpoint ?? DEFAULT_CONFIG.endpoint),
    model: String(value.model ?? DEFAULT_CONFIG.model).trim() || DEFAULT_CONFIG.model,
    systemPrompt:
      typeof value.systemPrompt === "string"
        ? value.systemPrompt
        : DEFAULT_CONFIG.systemPrompt,
    temperature: toNumber(value.temperature, DEFAULT_CONFIG.temperature),
    topP: toNumber(value.topP, DEFAULT_CONFIG.topP),
    topK: Math.max(0, toInteger(value.topK, DEFAULT_CONFIG.topK)),
    minP: Math.max(0, toNumber(value.minP, DEFAULT_CONFIG.minP)),
    maxTokens: Math.max(1, toInteger(value.maxTokens, DEFAULT_CONFIG.maxTokens)),
    presencePenalty: toNumber(
      value.presencePenalty,
      DEFAULT_CONFIG.presencePenalty,
    ),
    repetitionPenalty: Math.max(
      0,
      toNumber(value.repetitionPenalty, DEFAULT_CONFIG.repetitionPenalty),
    ),
    frequencyPenalty: toNumber(
      value.frequencyPenalty,
      DEFAULT_CONFIG.frequencyPenalty,
    ),
    enableThinking: toBoolean(
      value.enableThinking,
      DEFAULT_CONFIG.enableThinking,
    ),
    stream: toBoolean(value.stream, DEFAULT_CONFIG.stream),
    timeoutMs: Math.max(1000, toInteger(value.timeoutMs, DEFAULT_CONFIG.timeoutMs)),
    seed: toSeed(value.seed),
  };
}

async function readConfigFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return normalizeConfig(JSON.parse(raw));
}

export async function loadConfig() {
  try {
    return await readConfigFile(CONFIG_PATH);
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw error;
    }
  }

  try {
    const config = await readConfigFile(LEGACY_CONFIG_PATH);
    await saveConfig(config);
    return config;
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw error;
    }
  }

  const config = normalizeConfig(DEFAULT_CONFIG);
  await saveConfig(config);
  return config;
}

export async function saveConfig(config) {
  const normalized = normalizeConfig(config);
  const payload = `${JSON.stringify(normalized, null, 2)}\n`;
  await fs.writeFile(CONFIG_PATH, payload, "utf8");
  return normalized;
}

export function cloneDefaultConfig() {
  return normalizeConfig(DEFAULT_CONFIG);
}
