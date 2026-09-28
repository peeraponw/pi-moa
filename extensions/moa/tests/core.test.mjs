import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CONFIG,
  mergeConfigs,
  parseConfigObject,
  validateMergedConfig,
} from "../config.js";
import {
  AGGREGATOR_SYSTEM_PROMPT,
  MODEL_SYSTEM_PROMPT,
  appendAdvisorContext,
  buildAggregatorContext,
  buildOpinionContext,
  formatOpinionBlock,
  messageText,
  modelLabel,
  parseMoaCommand,
  renderResults,
} from "../core.js";

function sampleConfig() {
  return validateMergedConfig(structuredClone(DEFAULT_CONFIG));
}

test("parseMoaCommand routes reserved words and treats the rest as a prompt", () => {
  assert.deepEqual(parseMoaCommand(""), { type: "help" });
  assert.deepEqual(parseMoaCommand("   "), { type: "help" });
  assert.deepEqual(parseMoaCommand("setup"), { type: "setup" });
  assert.deepEqual(parseMoaCommand("list"), { type: "list" });
  assert.deepEqual(parseMoaCommand("help"), { type: "help" });
  assert.deepEqual(parseMoaCommand("  list  extra "), { type: "list" });
  assert.deepEqual(parseMoaCommand("review my diff"), {
    type: "run",
    prompt: "review my diff",
  });
});

test("parseConfigObject validates model references", () => {
  const invalid = {
    models: [{ name: "a", provider: "zai" }],
  };

  assert.throws(() => parseConfigObject(invalid, "test"), /models\[0\]\.model/);
});

test("parseConfigObject rejects thinking level outside the allowed set", () => {
  assert.throws(
    () =>
      parseConfigObject(
        {
          models: [{ provider: "zai", model: "glm-5.2", thinking: "ultra" }],
        },
        "test",
      ),
    /thinking must be one of/,
  );
});

test("parseConfigObject rejects legacy preset configs and names the new schema", () => {
  const legacy = {
    defaultPreset: "architect",
    presets: { architect: {} },
  };

  assert.throws(() => parseConfigObject(legacy, "test"), /models/);
  assert.throws(() => parseConfigObject(legacy, "test"), /aggregator/);
  assert.throws(() => parseConfigObject({ presets: {} }, "test"), /found legacy key\(s\) presets/);
});

test("parseConfigObject accepts an optional aggregator and null aggregator", () => {
  const withAggregator = parseConfigObject(
    {
      models: [{ name: "a", provider: "zai", model: "glm-5.2" }],
      aggregator: { provider: "zai", model: "glm-5.2", thinking: "high" },
    },
    "test",
  );
  assert.equal(withAggregator.aggregator.model, "glm-5.2");

  const removed = parseConfigObject(
    {
      models: [{ name: "a", provider: "zai", model: "glm-5.2" }],
      aggregator: null,
    },
    "test",
  );
  assert.equal("aggregator" in removed, true);
  assert.equal(removed.aggregator, null);
});

test("parseConfigObject rejects a name field on the aggregator", () => {
  assert.throws(
    () =>
      parseConfigObject(
        {
          models: [{ name: "a", provider: "zai", model: "glm-5.2" }],
          aggregator: { name: "merger", provider: "zai", model: "glm-5.2" },
        },
        "test",
      ),
    /aggregator must not have a name field/,
  );
});

test("mergeConfigs replaces the models array wholesale and overrides the aggregator", () => {
  const base = sampleConfig();
  const override = parseConfigObject(
    {
      models: [{ name: "solo", provider: "anthropic", model: "claude-opus-4.6" }],
      aggregator: { provider: "zai", model: "glm-5.2", thinking: "high" },
    },
    "override",
  );

  const merged = validateMergedConfig(mergeConfigs(base, override));

  assert.equal(merged.models.length, 1);
  assert.equal(merged.models[0].name, "solo");
  assert.equal(merged.aggregator.thinking, "high");
});

test("mergeConfigs lets a project remove a global aggregator with null", () => {
  const base = parseConfigObject(
    {
      models: [{ name: "a", provider: "zai", model: "glm-5.2" }],
      aggregator: { provider: "zai", model: "glm-5.2" },
    },
    "base",
  );
  const override = parseConfigObject(
    {
      models: [{ name: "a", provider: "zai", model: "glm-5.2" }],
      aggregator: null,
    },
    "override",
  );

  const merged = validateMergedConfig(mergeConfigs(base, override));

  assert.equal(merged.aggregator, undefined);
});

test("mergeConfigs keeps the global aggregator when the project omits it", () => {
  const base = parseConfigObject(
    {
      models: [{ name: "a", provider: "zai", model: "glm-5.2" }],
      aggregator: { provider: "zai", model: "glm-5.2" },
    },
    "base",
  );
  const override = parseConfigObject(
    { models: [{ name: "b", provider: "zai", model: "glm-5.2" }] },
    "override",
  );

  const merged = validateMergedConfig(mergeConfigs(base, override));

  assert.equal(merged.aggregator.model, "glm-5.2");
});

test("validateMergedConfig requires at least one model", () => {
  assert.throws(
    () => validateMergedConfig({ models: [] }),
    /must define at least one model/,
  );
});

test("buildOpinionContext keeps only user and assistant text and appends the prompt", () => {
  const sessionMessages = [
    { role: "user", content: [{ type: "text", text: "Fix this" }], timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I will inspect it." },
        { type: "toolCall", id: "1", name: "read", arguments: { path: "x" } },
      ],
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolName: "read",
      toolCallId: "1",
      content: [{ type: "text", text: "file contents" }],
      isError: false,
      timestamp: 3,
    },
    { role: "user", content: "string content", timestamp: 4 },
  ];

  const context = buildOpinionContext(sessionMessages, "What else should I check?");

  assert.equal(context.systemPrompt, MODEL_SYSTEM_PROMPT);
  assert.match(context.systemPrompt, /not tool results/);
  assert.equal(context.messages.length, 4);
  assert.equal(context.messages[1].content[0].text, "I will inspect it.");
  assert.equal(context.messages[2].content[0].text, "string content");
  const last = context.messages[3];
  assert.equal(last.role, "user");
  assert.equal(last.content[0].text, "What else should I check?");
  assert.doesNotMatch(JSON.stringify(context.messages), /file contents/);
});

test("appendAdvisorContext appends tagged text to the latest user message", () => {
  const context = {
    systemPrompt: "system",
    messages: [
      { role: "user", content: [{ type: "text", text: "Implement" }], timestamp: 1 },
    ],
    tools: [{ name: "read", description: "read", parameters: { type: "object" } }],
  };

  const next = appendAdvisorContext(context, "advisor notes");

  assert.equal(next.systemPrompt, "system");
  assert.equal(next.tools, context.tools);
  assert.equal(next.messages.length, 1);
  assert.equal(next.messages[0].content[1].text, "advisor notes");
});

test("appendAdvisorContext appends to string message content", () => {
  const context = {
    systemPrompt: "system",
    messages: [{ role: "user", content: "plain prompt", timestamp: 1 }],
  };

  const next = appendAdvisorContext(context, "advisor notes");

  assert.equal(next.messages[0].content, "plain prompt\n\nadvisor notes");
});

test("buildAggregatorContext swaps the system prompt and keeps the messages", () => {
  const opinionContext = buildOpinionContext([], "Should I ship it?");
  const aggregatorContext = buildAggregatorContext(opinionContext, "<opinions/>");

  assert.equal(aggregatorContext.systemPrompt, AGGREGATOR_SYSTEM_PROMPT);
  assert.match(aggregatorContext.systemPrompt, /merging independent second opinions/);
  assert.equal(aggregatorContext.messages.length, opinionContext.messages.length);
  const last = aggregatorContext.messages[aggregatorContext.messages.length - 1];
  assert.equal(last.role, "user");
  assert.equal(last.content[0].text, "Should I ship it?");
  assert.equal(last.content[1].text, "<opinions/>");
});

test("formatOpinionBlock wraps all opinions including failures", () => {
  const text = formatOpinionBlock([
    { ok: true, name: "a", label: "a (p/m)", text: "check tests" },
    { ok: false, name: "b", label: "b (p/m)", error: "missing key" },
  ]);

  assert.match(text, /<pi_moa_opinions>/);
  assert.match(text, /a:\ncheck tests/);
  assert.match(text, /b failed: missing key/);
});

test("renderResults shows one labeled section per model and the aggregator last", () => {
  const output = renderResults(
    [
      { ok: true, name: "a", label: "a (zai/glm-5.2:xhigh)", text: "opinion a" },
      { ok: false, name: "b", label: "b (x/y)", error: "model not found" },
    ],
    { ok: true, name: "agg", label: "(zai/glm-5.2:high)", text: "merged take" },
  );

  assert.match(output, /a \(zai\/glm-5\.2:xhigh\):\nopinion a/);
  assert.match(output, /b failed: model not found/);
  assert.match(output, /Aggregated \(zai\/glm-5\.2:high\):\nmerged take/);
  assert.ok(output.indexOf("merged take") > output.indexOf("opinion a"));
});

test("renderResults without an aggregator shows only the model sections", () => {
  const output = renderResults([{ ok: true, name: "a", label: "a (p/m)", text: "solo" }]);

  assert.equal(output, "a (p/m):\nsolo");
});

test("messageText extracts only text content", () => {
  const text = messageText({
    content: [
      { type: "thinking", thinking: "private reasoning" },
      { type: "text", text: "public advice" },
    ],
  });

  assert.equal(text, "public advice");
});

test("modelLabel includes name, provider, model, and thinking", () => {
  assert.equal(
    modelLabel({ name: "glm", provider: "zai", model: "glm-5.2", thinking: "high" }),
    "glm (zai/glm-5.2:high)",
  );
  assert.equal(modelLabel({ provider: "zai", model: "glm-5.2" }), "(zai/glm-5.2)");
});
