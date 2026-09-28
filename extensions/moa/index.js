import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { CONFIG_DIR_NAME, buildSessionContext, getAgentDir } from "@earendil-works/pi-coding-agent";

import {
  CONFIG_FILE,
  DEFAULT_CONFIG,
  clonePlain,
  mergeConfigs,
  parseConfigObject,
  validateMergedConfig,
} from "./config.js";
import {
  buildAggregatorContext,
  buildOpinionContext,
  formatOpinionBlock,
  messageText,
  modelLabel,
  parseMoaCommand,
  renderResults,
} from "./core.js";

const USAGE = "Usage: /moa <prompt>, /moa setup, /moa list, /moa help";

function parseJsonText(text, sourceLabel) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${sourceLabel}: invalid JSON: ${message}`);
  }
}

async function readJsonConfig(path, sourceLabel) {
  if (!existsSync(path)) return undefined;
  const text = await readFile(path, "utf8");
  return parseConfigObject(parseJsonText(text, sourceLabel), sourceLabel);
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

function buildOptions(ref) {
  const options = {};
  if (ref.thinking && ref.thinking !== "off") options.reasoning = ref.thinking;
  if (ref.temperature !== undefined) options.temperature = ref.temperature;
  if (ref.maxTokens !== undefined) options.maxTokens = ref.maxTokens;
  return options;
}

async function runModel(registry, ref, context) {
  const label = modelLabel(ref);
  const name = ref.name ?? `${ref.provider}/${ref.model}`;
  try {
    const model = registry.find(ref.provider, ref.model);
    if (!model) throw new Error(`model not found: ${ref.provider}/${ref.model}`);
    const result = await registry.streamSimple(model, context, buildOptions(ref)).result();
    if (result.stopReason === "error" || result.stopReason === "aborted") {
      throw new Error(result.errorMessage ?? `stopped: ${result.stopReason}`);
    }
    return { ok: true, label, name, text: messageText(result) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, label, name, error: message };
  }
}

async function runSecondOpinion(ctx, prompt) {
  const { config } = await loadConfig(ctx.cwd, ctx.isProjectTrusted());

  const sessionMessages = buildSessionContext(
    ctx.sessionManager.getEntries(),
    ctx.sessionManager.getLeafId(),
  ).messages;

  const opinionContext = buildOpinionContext(sessionMessages, prompt);
  const results = await Promise.all(
    config.models.map((ref) => runModel(ctx.modelRegistry, ref, opinionContext)),
  );

  let aggregatorResult;
  if (config.aggregator) {
    const aggregatorContext = buildAggregatorContext(
      opinionContext,
      formatOpinionBlock(results),
    );
    aggregatorResult = await runModel(ctx.modelRegistry, config.aggregator, aggregatorContext);
  }

  ctx.ui.notify(renderResults(results, aggregatorResult), "info");
}

function formatModelList(config) {
  const models = config.models.map((ref) => `- ${modelLabel(ref)}`).join("\n");
  const aggregator = config.aggregator
    ? `- aggregator: ${modelLabel(config.aggregator)}`
    : "No aggregator configured.";
  return `Models:\n${models}\n${aggregator}`;
}

async function listConfig(ctx) {
  const { config, sources } = await loadConfig(ctx.cwd, ctx.isProjectTrusted());
  ctx.ui.notify(`${formatModelList(config)}\nSources: ${sources.join(", ")}`, "info");
}

async function writeConfig(path, configText) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${configText.trim()}\n`, "utf8");
}

async function setupConfig(ctx) {
  const target = await ctx.ui.select("Save MoA config where?", ["global", "project"]);
  if (!target) return;

  const targetPath = target === "global"
    ? join(getAgentDir(), CONFIG_FILE)
    : join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_FILE);

  const initial = existsSync(targetPath)
    ? await readFile(targetPath, "utf8")
    : `${JSON.stringify(clonePlain(DEFAULT_CONFIG), null, 2)}\n`;

  const edited = await ctx.ui.editor(`Edit ${targetPath}`, initial);
  if (edited === undefined) return;

  parseConfigObject(parseJsonText(edited, targetPath), targetPath);
  await writeConfig(targetPath, edited);
  ctx.ui.notify(`Saved MoA config: ${targetPath}`, "info");

  if (target === "project" && !ctx.isProjectTrusted()) {
    ctx.ui.notify(
      "This project is not trusted, so .pi/moa.json will not be read until you trust it.",
      "warning",
    );
  }
}

async function handleMoaCommand(args, ctx) {
  const command = parseMoaCommand(args);
  try {
    if (command.type === "help") return ctx.ui.notify(USAGE, "info");
    if (command.type === "list") return await listConfig(ctx);
    if (command.type === "setup") return await setupConfig(ctx);
    return await runSecondOpinion(ctx, command.prompt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(message, "error");
  }
}

export default async function moaExtension(pi) {
  pi.registerCommand("moa", {
    description: "Ask every configured model for a second opinion",
    handler: (args, ctx) => handleMoaCommand(args, ctx),
  });
}
