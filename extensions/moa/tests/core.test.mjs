import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CONFIG,
  clonePlain,
  mergeConfigs,
  parseConfigObject,
  validateMergedConfig,
} from "../config.js";
import {
  appendAdvisorContext,
  buildAdvisorContext,
  filterMoAContextMessages,
  formatAdvisorContext,
  messageText,
  parseMoaCommand,
  shouldRunAdvisorsForContext,
} from "../core.js";

function sampleConfig() {
  return validateMergedConfig(clonePlain(DEFAULT_CONFIG));
}

test("parseMoaCommand routes named presets and default prompts", () => {
  const config = sampleConfig();

  const named = parseMoaCommand("bug find the race", config);
  const fallback = parseMoaCommand("find the race", config);

  assert.deepEqual(named, { type: "run", presetName: "bug", prompt: "find the race" });
  assert.deepEqual(fallback, {
    type: "run",
    presetName: "architect",
    prompt: "find the race",
  });
});

test("parseConfigObject validates model references", () => {
  const invalid = {
    presets: {
      custom: { aggregator: { provider: "zai" } },
    },
  };

  assert.throws(() => parseConfigObject(invalid, "test"), /aggregator.model/);
});

test("mergeConfigs lets project presets override global preset fields", () => {
  const base = sampleConfig();
  const override = parseConfigObject(
    {
      defaultPreset: "bug",
      presets: {
        bug: {
          aggregator: { provider: "zai", model: "glm-5.2", thinking: "xhigh" },
        },
      },
    },
    "override",
  );

  const merged = validateMergedConfig(mergeConfigs(base, override));

  assert.equal(merged.defaultPreset, "bug");
  assert.equal(merged.presets.bug.aggregator.thinking, "xhigh");
  assert.equal(merged.presets.bug.advisors.length, 2);
});

test("buildAdvisorContext includes only user and assistant text", () => {
  const context = {
    messages: [
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
    ],
  };

  const advisor = sampleConfig().presets.bug.advisors[0];
  const advisorContext = buildAdvisorContext(context, advisor, "bug");

  assert.match(advisorContext.systemPrompt, /not tool results/);
  assert.equal(advisorContext.messages.length, 2);
  assert.equal(advisorContext.messages[1].content[0].text, "I will inspect it.");
  assert.doesNotMatch(JSON.stringify(advisorContext.messages), /file contents/);
});

test("shouldRunAdvisorsForContext only runs on user-facing turns", () => {
  assert.equal(
    shouldRunAdvisorsForContext({
      messages: [{ role: "user", content: [{ type: "text", text: "start" }] }],
    }),
    true,
  );
  assert.equal(
    shouldRunAdvisorsForContext({
      messages: [{ role: "toolResult", content: [], isError: false }],
    }),
    false,
  );
});

test("appendAdvisorContext adds private advisor text to latest user turn", () => {
  const context = {
    systemPrompt: "system",
    messages: [{ role: "user", content: [{ type: "text", text: "Implement" }], timestamp: 1 }],
    tools: [{ name: "read", description: "read", parameters: { type: "object" } }],
  };

  const next = appendAdvisorContext(context, "advisor notes");

  assert.equal(next.systemPrompt, "system");
  assert.equal(next.tools, context.tools);
  assert.equal(next.messages.length, 1);
  assert.equal(next.messages[0].content[1].text, "advisor notes");
});

test("filterMoAContextMessages removes prior visible advisor blocks", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "[pi-moa-advisors] preset=bug\nnotes" },
        { type: "text", text: "aggregator answer" },
      ],
      timestamp: 1,
    },
    { role: "user", content: [{ type: "text", text: "next" }], timestamp: 2 },
  ];

  const filtered = filterMoAContextMessages(messages);

  assert.equal(filtered.length, 2);
  assert.deepEqual(filtered[0].content, [{ type: "text", text: "aggregator answer" }]);
});

test("messageText excludes advisor thinking blocks", () => {
  const text = messageText({
    content: [
      { type: "thinking", thinking: "private reasoning" },
      { type: "text", text: "public advice" },
    ],
  });

  assert.equal(text, "public advice");
});

test("formatAdvisorContext wraps all advisor outputs for the aggregator", () => {
  const text = formatAdvisorContext(
    [
      { ok: true, name: "a", model: "(p/m:xhigh)", text: "check tests" },
      { ok: false, name: "b", error: "missing key" },
    ],
    "review",
  );

  assert.match(text, /<pi_moa_advisor_context preset="review">/);
  assert.match(text, /Advisor a/);
  assert.match(text, /Advisor b failed: missing key/);
});
