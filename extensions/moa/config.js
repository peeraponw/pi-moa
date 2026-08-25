const PROVIDER_ID = "moa";
const MOA_API_ID = "pi-moa";
const CONFIG_FILE = "moa.json";
const TRANSCRIPT_PREFIX = "[pi-moa-advisors]";
const ADVISOR_CONTEXT_TAG = "pi_moa_advisor_context";
const DEFAULT_CONTEXT_WINDOW = 200000;
const DEFAULT_MAX_TOKENS = 16384;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

const DEFAULT_AGGREGATOR = {
  provider: "zai",
  model: "glm-5.2",
  thinking: "high",
};

const DEFAULT_ADVISORS = [
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
];

const PRESET_ROLES = {
  default: "Give broad coding advice, note risks, and suggest the next best action.",
  architect: "Focus on architecture, decomposition, integration points, and tradeoffs.",
  bug: "Find likely bugs, edge cases, incorrect assumptions, and missing tests.",
  review: "Review for correctness, maintainability, security, and standards compliance.",
  plan: "Produce an execution plan with sequencing, verification, and rollback concerns.",
  debug: "Reason about root cause, observability, hypotheses, and minimal repro steps.",
};

function advisorWithRole(advisor, role) {
  return {
    ...advisor,
    role,
  };
}

function makePreset(name, description) {
  const role = PRESET_ROLES[name] ?? PRESET_ROLES.default;
  return {
    description,
    enabled: true,
    visibleAdvisorOutputs: true,
    advisors: DEFAULT_ADVISORS.map((advisor) => advisorWithRole(advisor, role)),
    aggregator: { ...DEFAULT_AGGREGATOR },
  };
}

const DEFAULT_CONFIG = {
  defaultPreset: "architect",
  visibleAdvisorOutputs: true,
  presets: {
    default: makePreset("default", "General coding MoA"),
    architect: makePreset("architect", "Architecture and design MoA"),
    bug: makePreset("bug", "Bug-finding MoA"),
    review: makePreset("review", "Code review MoA"),
    plan: makePreset("plan", "Planning MoA"),
    debug: makePreset("debug", "Debugging MoA"),
  },
};

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
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

  return {
    name: typeof value.name === "string" ? value.name : undefined,
    provider,
    model,
    thinking: readThinking(value.thinking, `${path}.thinking`, errors),
    role: typeof value.role === "string" ? value.role : undefined,
    maxTokens: readOptionalNumber(value.maxTokens, `${path}.maxTokens`, errors),
    temperature: readOptionalNumber(value.temperature, `${path}.temperature`, errors),
  };
}

function readPreset(value, path, errors) {
  if (!isObject(value)) {
    errors.push(`${path} must be an object`);
    return undefined;
  }

  const advisors = Array.isArray(value.advisors)
    ? value.advisors.map((advisor, index) => {
        return readModelRef(advisor, `${path}.advisors[${index}]`, errors);
      })
    : undefined;

  const preset = {
    description: typeof value.description === "string" ? value.description : undefined,
    enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
    visibleAdvisorOutputs:
      typeof value.visibleAdvisorOutputs === "boolean" ? value.visibleAdvisorOutputs : undefined,
    advisors: advisors?.filter(Boolean),
    aggregator: value.aggregator
      ? readModelRef(value.aggregator, `${path}.aggregator`, errors)
      : undefined,
    referenceMaxTokens: readOptionalNumber(
      value.referenceMaxTokens,
      `${path}.referenceMaxTokens`,
      errors,
    ),
    maxTokens: readOptionalNumber(value.maxTokens, `${path}.maxTokens`, errors),
  };

  return Object.fromEntries(Object.entries(preset).filter(([, item]) => item !== undefined));
}

function parseConfigObject(value, sourceLabel) {
  const errors = [];
  if (!isObject(value)) {
    throw new Error(`${sourceLabel}: config must be a JSON object`);
  }

  const parsed = {};
  if (value.defaultPreset !== undefined) {
    parsed.defaultPreset = assertString(value.defaultPreset, "defaultPreset", errors);
  }
  if (value.visibleAdvisorOutputs !== undefined) {
    if (typeof value.visibleAdvisorOutputs !== "boolean") {
      errors.push("visibleAdvisorOutputs must be a boolean");
    } else {
      parsed.visibleAdvisorOutputs = value.visibleAdvisorOutputs;
    }
  }

  if (value.presets !== undefined) {
    if (!isObject(value.presets)) {
      errors.push("presets must be an object");
    } else {
      parsed.presets = {};
      for (const [name, preset] of Object.entries(value.presets)) {
        parsed.presets[name] = readPreset(preset, `presets.${name}`, errors);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`${sourceLabel}: invalid MoA config\n- ${errors.join("\n- ")}`);
  }
  return parsed;
}

function mergePreset(basePreset, overridePreset) {
  const merged = { ...(basePreset ?? {}), ...overridePreset };
  if (basePreset?.aggregator && overridePreset?.aggregator) {
    merged.aggregator = { ...basePreset.aggregator, ...overridePreset.aggregator };
  }
  return merged;
}

function mergeConfigs(baseConfig, overrideConfig) {
  const merged = clonePlain(baseConfig);
  if (overrideConfig.defaultPreset) merged.defaultPreset = overrideConfig.defaultPreset;
  if (overrideConfig.visibleAdvisorOutputs !== undefined) {
    merged.visibleAdvisorOutputs = overrideConfig.visibleAdvisorOutputs;
  }
  if (overrideConfig.presets) {
    for (const [name, preset] of Object.entries(overrideConfig.presets)) {
      merged.presets[name] = mergePreset(merged.presets[name], preset);
    }
  }
  return merged;
}

function validateMergedConfig(config) {
  const presetNames = Object.keys(config.presets ?? {});
  if (presetNames.length === 0) throw new Error("MoA config must define at least one preset");
  if (!config.presets[config.defaultPreset]) {
    throw new Error(`MoA defaultPreset '${config.defaultPreset}' does not exist in presets`);
  }

  for (const [name, preset] of Object.entries(config.presets)) {
    if (!preset.aggregator) throw new Error(`MoA preset '${name}' must define aggregator`);
    if (!Array.isArray(preset.advisors)) preset.advisors = [];
  }
  return config;
}

export {
  ADVISOR_CONTEXT_TAG,
  CONFIG_FILE,
  DEFAULT_CONFIG,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  MOA_API_ID,
  PROVIDER_ID,
  TRANSCRIPT_PREFIX,
  clonePlain,
  mergeConfigs,
  parseConfigObject,
  validateMergedConfig,
};
