const CONFIG_FILE = "moa.json";
const ADVISOR_CONTEXT_TAG = "pi_moa_opinions";
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const DEFAULT_CONFIG = {
  models: [
    {
      name: "glm-5.2",
      provider: "zai",
      model: "glm-5.2",
      thinking: "xhigh",
    },
    {
      name: "gpt-5.5",
      provider: "openai-codex",
      model: "gpt-5.5",
      thinking: "xhigh",
    },
  ],
};

function clonePlain(value) {
  return structuredClone(value);
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value, path, errors) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${path} must be a non-empty string`);
    return undefined;
  }
  return value;
}

function readOptionalNumber(value, path, errors) {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || value < 0 || !Number.isFinite(value)) {
    errors.push(`${path} must be a non-negative number`);
    return undefined;
  }
  return value;
}

function readThinking(value, path, errors) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !THINKING_LEVELS.has(value)) {
    errors.push(`${path} must be one of ${Array.from(THINKING_LEVELS).join(", ")}`);
    return undefined;
  }
  return value;
}

function readModelRef(value, path, errors) {
  if (!isObject(value)) {
    errors.push(`${path} must be an object`);
    return undefined;
  }

  const provider = assertString(value.provider, `${path}.provider`, errors);
  const model = assertString(value.model, `${path}.model`, errors);
  if (!provider || !model) return undefined;

  const ref = {
    provider,
    model,
    thinking: readThinking(value.thinking, `${path}.thinking`, errors),
    maxTokens: readOptionalNumber(value.maxTokens, `${path}.maxTokens`, errors),
    temperature: readOptionalNumber(value.temperature, `${path}.temperature`, errors),
  };
  return Object.fromEntries(Object.entries(ref).filter(([, item]) => item !== undefined));
}

function readNamedModelRef(value, path, errors) {
  if (!isObject(value)) {
    errors.push(`${path} must be an object`);
    return undefined;
  }
  const ref = readModelRef(value, path, errors);
  if (!ref) return undefined;
  const name = typeof value.name === "string" && value.name.trim() !== "" ? value.name : undefined;
  return name ? { name, ...ref } : ref;
}

const LEGACY_KEYS = ["presets", "defaultPreset", "visibleAdvisorOutputs"];
const NEW_SCHEMA_HINT =
  "MoA config now uses { \"models\": [...], \"aggregator\": {...} }. " +
  "Presets were removed. Replace presets.<name>.advisors with the top-level models array " +
  "and presets.<name>.aggregator with the top-level aggregator.";

function parseConfigObject(value, sourceLabel) {
  const errors = [];
  if (!isObject(value)) {
    throw new Error(`${sourceLabel}: config must be a JSON object`);
  }

  const legacy = LEGACY_KEYS.filter((key) => value[key] !== undefined);
  if (legacy.length > 0) {
    throw new Error(`${sourceLabel}: found legacy key(s) ${legacy.join(", ")}. ${NEW_SCHEMA_HINT}`);
  }

  const parsed = {};
  if (value.models === undefined) {
    errors.push("models is required and must be a non-empty array");
  } else if (!Array.isArray(value.models)) {
    errors.push("models must be an array");
  } else {
    parsed.models = value.models.map((model, index) =>
      readNamedModelRef(model, `models[${index}]`, errors),
    );
  }

  if (value.aggregator !== undefined) {
    if (value.aggregator === null) {
      parsed.aggregator = null;
    } else {
      if (isObject(value.aggregator) && value.aggregator.name !== undefined) {
        errors.push("aggregator must not have a name field. Only models take a name label.");
      }
      const aggregator = readModelRef(value.aggregator, "aggregator", errors);
      if (aggregator) parsed.aggregator = aggregator;
    }
  }

  if (errors.length > 0) {
    throw new Error(`${sourceLabel}: invalid MoA config\n- ${errors.join("\n- ")}`);
  }
  return parsed;
}

function mergeConfigs(baseConfig, overrideConfig) {
  const merged = clonePlain(baseConfig);
  if (overrideConfig.models) merged.models = clonePlain(overrideConfig.models);
  if (Object.hasOwn(overrideConfig, "aggregator")) {
    if (overrideConfig.aggregator) merged.aggregator = clonePlain(overrideConfig.aggregator);
    else delete merged.aggregator;
  }
  return merged;
}

function validateMergedConfig(config) {
  if (!Array.isArray(config.models) || config.models.length === 0) {
    throw new Error("MoA config must define at least one model in models");
  }
  return config;
}

export {
  ADVISOR_CONTEXT_TAG,
  CONFIG_FILE,
  DEFAULT_CONFIG,
  clonePlain,
  mergeConfigs,
  parseConfigObject,
  validateMergedConfig,
};
