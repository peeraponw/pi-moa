import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { createAssistantMessageEventStream, streamSimple } from "@earendil-works/pi-ai/compat";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

import {
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
} from "./config.js";
import {
  appendAdvisorContext,
  buildAdvisorContext,
  formatAdvisorContext,
  formatAdvisorTranscript,
  messageText,
  modelLabel,
  parseMoaCommand,
  shouldRunAdvisorsForContext,
  shouldShowAdvisorOutputs,
  filterMoAContextMessages,
} from "./core.js";

const SETUP_COMMANDS = new Set(["setup", "reload", "list", "help"]);

let activeConfig = validateMergedConfig(clonePlain(DEFAULT_CONFIG));
let activeSources = [];
let currentRegistry;
let oneShotRestore;
const advisorContextCache = new Map();

function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function errorMessage(model, message) {
  return {
    role: "assistant",
    content: [{ type: "text", text: message }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: "error",
    errorMessage: message,
    timestamp: Date.now(),
  };
}

function emitError(stream, model, message) {
  const output = errorMessage(model, message);
  stream.push({ type: "start", partial: output });
  stream.push({ type: "error", reason: "error", error: output });
  stream.end();
}

async function readJsonConfig(path, sourceLabel) {
  if (!existsSync(path)) return undefined;
  const text = await readFile(path, "utf8");
  const value = JSON.parse(text);
  return parseConfigObject(value, sourceLabel);
}

async function loadConfig(cwd, includeProject) {
  const globalPath = join(getAgentDir(), CONFIG_FILE);
  const projectPath = join(cwd, CONFIG_DIR_NAME, CONFIG_FILE);
  let config = clonePlain(DEFAULT_CONFIG);
  const sources = ["built-in defaults"];

  const globalConfig = await readJsonConfig(globalPath, globalPath);
  if (globalConfig) {
    config = mergeConfigs(config, globalConfig);
    sources.push(globalPath);
  }

  if (includeProject) {
    const projectConfig = await readJsonConfig(projectPath, projectPath);
    if (projectConfig) {
      config = mergeConfigs(config, projectConfig);
      sources.push(projectPath);
    }
  }

  return { config: validateMergedConfig(config), sources };
}

function registerProvider(pi) {
  const models = Object.entries(activeConfig.presets).map(([id, preset]) => ({
    id,
    name: `MoA: ${id}${preset.description ? ` — ${preset.description}` : ""}`,
    api: MOA_API_ID,
    baseUrl: "moa://local",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: preset.maxTokens ?? DEFAULT_MAX_TOKENS,
  }));

  pi.registerProvider(PROVIDER_ID, {
    name: "Mixture of Agents",
    baseUrl: "moa://local",
    apiKey: "moa",
    api: MOA_API_ID,
    models,
    streamSimple: streamMoA,
  });
}

function buildOptions(baseOptions, modelRef, auth, fallbackMaxTokens) {
  const options = {
    ...baseOptions,
    apiKey: auth.apiKey,
    headers: auth.headers,
    env: auth.env,
  };
  if (modelRef.thinking === "off") delete options.reasoning;
  else if (modelRef.thinking) options.reasoning = modelRef.thinking;
  if (modelRef.temperature !== undefined) options.temperature = modelRef.temperature;
  if (modelRef.maxTokens !== undefined) options.maxTokens = modelRef.maxTokens;
  if (fallbackMaxTokens) options.maxTokens = options.maxTokens ?? fallbackMaxTokens;
  return options;
}

async function resolveModel(registry, modelRef, label) {
  if (modelRef.provider === PROVIDER_ID) {
    throw new Error(`${label} cannot reference another MoA preset`);
  }
  const model = registry.find(modelRef.provider, modelRef.model);
  if (!model) throw new Error(`${label} model not found: ${modelRef.provider}/${modelRef.model}`);
  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(`${label} auth failed for ${modelRef.provider}: ${auth.error}`);
  return { model, auth };
}

async function runAdvisor(registry, advisor, presetName, context, options, maxTokens) {
  try {
    const { model, auth } = await resolveModel(registry, advisor, `advisor ${advisor.name}`);
    const advisorContext = buildAdvisorContext(context, advisor, presetName);
    const advisorOptions = buildOptions(options, advisor, auth, maxTokens);
    const result = await streamSimple(model, advisorContext, advisorOptions).result();
    if (result.stopReason === "error" || result.stopReason === "aborted") {
      throw new Error(result.errorMessage ?? result.stopReason);
    }
    return {
      ok: true,
      name: advisor.name ?? model.id,
      model: modelLabel(advisor),
      text: messageText(result),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, name: advisor.name ?? modelLabel(advisor), error: message };
  }
}

async function runAdvisors(registry, preset, presetName, context, options) {
  if (preset.enabled === false) return [];
  const maxTokens = preset.referenceMaxTokens || undefined;
  const tasks = preset.advisors.map((advisor) => {
    return runAdvisor(registry, advisor, presetName, context, options, maxTokens);
  });
  return Promise.all(tasks);
}

function pushAdvisorBlock(stream, output, advisorText) {
  const contentIndex = output.content.length;
  const block = { type: "thinking", thinking: advisorText };
  output.content.push(block);
  stream.push({ type: "thinking_start", contentIndex, partial: output });
  stream.push({ type: "thinking_delta", contentIndex, delta: advisorText, partial: output });
  stream.push({ type: "thinking_end", contentIndex, content: advisorText, partial: output });
}

function copyBlock(block) {
  return JSON.parse(JSON.stringify(block));
}

function copyAggregatorBlock(event, output, indexMap) {
  const source = event.partial.content[event.contentIndex];
  if (!source) return undefined;
  if (!indexMap.has(event.contentIndex)) {
    indexMap.set(event.contentIndex, output.content.length);
    output.content.push(copyBlock(source));
  } else {
    output.content[indexMap.get(event.contentIndex)] = copyBlock(source);
  }
  return indexMap.get(event.contentIndex);
}

function pushAggregatorEvent(stream, event, output, indexMap, advisorContentCount) {
  if (event.type === "start") return;
  if (event.type === "done" || event.type === "error") {
    const finalMessage = event.type === "done" ? event.message : event.error;
    const advisorContent = output.content.slice(0, advisorContentCount);
    const finalContent = finalMessage.content.map(copyBlock);
    Object.assign(output, { ...finalMessage, content: [...advisorContent, ...finalContent] });
    const mergedEvent = event.type === "done"
      ? { ...event, message: output }
      : { ...event, error: output };
    stream.push(mergedEvent);
    return;
  }

  const contentIndex = copyAggregatorBlock(event, output, indexMap);
  if (contentIndex === undefined) return;
  if (event.type === "toolcall_end") {
    stream.push({
      ...event,
      contentIndex,
      toolCall: output.content[contentIndex],
      partial: output,
    });
  } else {
    stream.push({ ...event, contentIndex, partial: output });
  }
}

async function pipeAggregator(stream, output, model, context, options) {
  const indexMap = new Map();
  const advisorContentCount = output.content.length;
  const aggregatorStream = streamSimple(model, context, options);
  for await (const event of aggregatorStream) {
    pushAggregatorEvent(stream, event, output, indexMap, advisorContentCount);
  }
  stream.end();
}

function makeInitialOutput(model, aggregatorModel) {
  return {
    role: "assistant",
    content: [],
    api: aggregatorModel.api,
    provider: aggregatorModel.provider,
    model: aggregatorModel.id,
    responseModel: `${PROVIDER_ID}/${model.id}`,
    usage: zeroUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function streamMoA(model, context, options = {}) {
  const stream = createAssistantMessageEventStream();
  void runMoAStream(stream, model, context, options);
  return stream;
}

function advisorCacheKey(model, options) {
  return `${options.sessionId ?? "default"}:${model.id}`;
}

async function runMoAStream(stream, virtualModel, context, options) {
  let started = false;
  try {
    if (!currentRegistry) throw new Error("MoA model registry is not ready yet");
    const preset = activeConfig.presets[virtualModel.id];
    if (!preset) throw new Error(`MoA preset not found: ${virtualModel.id}`);

    const { model: aggregatorModel, auth } = await resolveModel(
      currentRegistry,
      preset.aggregator,
      "aggregator",
    );
    const output = makeInitialOutput(virtualModel, aggregatorModel);
    stream.push({ type: "start", partial: output });
    started = true;

    const cacheKey = advisorCacheKey(virtualModel, options);
    const shouldRun = shouldRunAdvisorsForContext(context);
    const results = shouldRun
      ? await runAdvisors(currentRegistry, preset, virtualModel.id, context, options)
      : [];
    if (shouldRun && shouldShowAdvisorOutputs(activeConfig, preset) && results.length > 0) {
      pushAdvisorBlock(stream, output, formatAdvisorTranscript(results, virtualModel.id));
    }

    let advisorContext = shouldRun ? undefined : advisorContextCache.get(cacheKey);
    if (shouldRun && results.length > 0) {
      advisorContext = formatAdvisorContext(results, virtualModel.id);
      advisorContextCache.set(cacheKey, advisorContext);
    } else if (shouldRun) {
      advisorContextCache.delete(cacheKey);
    }
    const aggregatorContext = advisorContext
      ? appendAdvisorContext(context, advisorContext)
      : { ...context, messages: filterMoAContextMessages(context.messages) };
    const aggregatorOptions = buildOptions(options, preset.aggregator, auth, preset.maxTokens);
    await pipeAggregator(stream, output, aggregatorModel, aggregatorContext, aggregatorOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (started) {
      const output = errorMessage(virtualModel, message);
      stream.push({ type: "error", reason: "error", error: output });
      stream.end();
    } else {
      emitError(stream, virtualModel, message);
    }
  }
}

function formatPresetList(config) {
  return Object.entries(config.presets)
    .map(([name, preset]) => {
      const advisors = preset.advisors.map(modelLabel).join(", ") || "none";
      return `- ${name}: ${preset.description ?? "MoA preset"}\n  advisors: ${advisors}`;
    })
    .join("\n");
}

function moaSuggestionPrompt(config) {
  const presets = Object.keys(config.presets).join(", ");
  return [
    "Mixture-of-agents is available via /moa [preset] <prompt>.",
    `Available presets: ${presets}.`,
    "Do not trigger MoA automatically.",
    "For unusually complex architecture, debugging, review, or planning tasks,",
    "ask whether the user wants to rerun the request through /moa first.",
    "For straightforward tasks, continue normally without mentioning MoA.",
  ].join("\n");
}

async function writeConfig(path, configText) {
  await mkdir(dirname(path), { recursive: true });
  JSON.parse(configText);
  await writeFile(path, `${configText.trim()}\n`, "utf8");
}

async function setupConfig(ctx, pi) {
  const target = await ctx.ui.select("Save MoA config where?", ["global", "project"]);
  if (!target) return;

  const targetPath = target === "global"
    ? join(getAgentDir(), CONFIG_FILE)
    : join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_FILE);
  const initial = JSON.stringify(activeConfig, null, 2);
  const edited = await ctx.ui.editor(`Edit ${targetPath}`, initial);
  if (!edited) return;

  await writeConfig(targetPath, edited);
  const loaded = await loadConfig(ctx.cwd, ctx.isProjectTrusted());
  activeConfig = loaded.config;
  activeSources = loaded.sources;
  registerProvider(pi);
  ctx.ui.notify(`Saved MoA config: ${targetPath}`, "info");
}

async function reloadConfig(ctx, pi) {
  const loaded = await loadConfig(ctx.cwd, ctx.isProjectTrusted());
  activeConfig = loaded.config;
  activeSources = loaded.sources;
  registerProvider(pi);
  ctx.ui.notify(`MoA config reloaded from ${activeSources.join(", ")}`, "info");
}

async function restoreOneShot(pi, ctx) {
  if (!oneShotRestore) return;
  const restore = oneShotRestore;
  oneShotRestore = undefined;
  if (restore.model) await pi.setModel(restore.model);
  if (restore.thinking) pi.setThinkingLevel(restore.thinking);
  ctx.ui.notify("Restored model after /moa one-shot", "info");
}

async function runOneShot(pi, ctx, presetName, prompt) {
  if (!prompt.trim()) {
    ctx.ui.notify(`Usage: /moa ${presetName} <prompt>`, "warning");
    return;
  }

  const model = ctx.modelRegistry.find(PROVIDER_ID, presetName);
  if (!model) throw new Error(`MoA preset model not registered: ${presetName}`);
  oneShotRestore = { model: ctx.model, thinking: pi.getThinkingLevel() };
  const success = await pi.setModel(model);
  if (!success) throw new Error("Could not switch to MoA model. Run /moa setup first.");

  const thinking = activeConfig.presets[presetName]?.aggregator?.thinking;
  if (thinking) pi.setThinkingLevel(thinking);
  try {
    await pi.sendUserMessage(prompt);
  } catch (error) {
    await restoreOneShot(pi, ctx);
    throw error;
  }
}

async function handleMoaCommand(pi, args, ctx) {
  const command = parseMoaCommand(args, activeConfig);
  if (command.type === "setup") return setupConfig(ctx, pi);
  if (command.type === "reload") return reloadConfig(ctx, pi);
  if (command.type === "list") return ctx.ui.notify(formatPresetList(activeConfig), "info");
  if (command.type === "help") {
    return ctx.ui.notify("Usage: /moa [preset] <prompt>, /moa setup, /moa list", "info");
  }
  if (!SETUP_COMMANDS.has(command.type)) {
    return runOneShot(pi, ctx, command.presetName, command.prompt);
  }
}

function registerCommand(pi) {
  pi.registerCommand("moa", {
    description: "Run or configure mixture-of-agents presets",
    handler: (args, ctx) => handleMoaCommand(pi, args, ctx),
  });
}

export default async function moaExtension(pi) {
  const startupConfig = await loadConfig(process.cwd(), false);
  activeConfig = startupConfig.config;
  activeSources = startupConfig.sources;
  registerProvider(pi);
  registerCommand(pi);

  pi.on("session_start", async (_event, ctx) => {
    currentRegistry = ctx.modelRegistry;
    try {
      const loaded = await loadConfig(ctx.cwd, ctx.isProjectTrusted());
      activeConfig = loaded.config;
      activeSources = loaded.sources;
      registerProvider(pi);
      if (activeSources.length === 1) {
        ctx.ui.notify("MoA is using built-in defaults. Run /moa setup to customize.", "info");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(message, "error");
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (ctx.model?.provider === PROVIDER_ID) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${moaSuggestionPrompt(activeConfig)}` };
  });

  pi.on("context", (event) => {
    return { messages: filterMoAContextMessages(event.messages) };
  });

  pi.on("agent_end", async (_event, ctx) => {
    await restoreOneShot(pi, ctx);
  });
}
