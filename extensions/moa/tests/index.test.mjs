import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = mkdtempSync(join(tmpdir(), "pi-moa-test-"));
const agentDir = join(root, "agent");
const projectDir = join(root, "project");
mkdirSync(agentDir, { recursive: true });
mkdirSync(join(projectDir, ".pi"), { recursive: true });

process.env.PI_CODING_AGENT_DIR = agentDir;

const globalConfigPath = join(agentDir, "moa.json");
const projectConfigPath = join(projectDir, ".pi", "moa.json");

after(() => {
  rmSync(root, { recursive: true, force: true });
});

const moa = (await import("../index.js")).default;

let registered;
moa({
  registerCommand: (name, def) => {
    registered = { name, def };
  },
});
assert.equal(registered.name, "moa");
assert.equal(typeof registered.def.handler, "function");

const notifications = [];
const capturedRequests = [];
let editorCalls = 0;

const sessionEntries = [
  {
    type: "message",
    id: "u1",
    timestamp: 1,
    message: { role: "user", content: [{ type: "text", text: "Fix the login bug" }] },
  },
  {
    type: "message",
    id: "a1",
    parentId: "u1",
    timestamp: 2,
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "I will inspect auth.js." },
        { type: "toolCall", id: "t1", name: "read", arguments: { path: "auth.js" } },
      ],
    },
  },
  {
    type: "message",
    id: "r1",
    parentId: "a1",
    timestamp: 3,
    message: {
      role: "toolResult",
      toolName: "read",
      toolCallId: "t1",
      content: [{ type: "text", text: "SECRET CONTENT" }],
      isError: false,
    },
  },
];

function makeCtx({ trusted = true, models = new Set(["glm-5.2", "gpt-5.5"]), select, editor } = {}) {
  return {
    cwd: projectDir,
    isProjectTrusted: () => trusted,
    ui: {
      notify: (message, type) => notifications.push({ message, type }),
      select: async () => select,
      editor: async () => {
        editorCalls += 1;
        return editor;
      },
    },
    sessionManager: {
      getLeafId: () => undefined,
      getEntries: () => sessionEntries,
    },
    modelRegistry: {
      find: (provider, modelId) => (models.has(modelId) ? { id: modelId, provider } : undefined),
      streamSimple: (model, context, options) => {
        capturedRequests.push({ model, context, options });
        return {
          result: async () => ({
            stopReason: "stop",
            content: [{ type: "text", text: `answer from ${model.provider}/${model.id}` }],
          }),
        };
      },
    },
  };
}

async function run(args, ctxOptions = {}) {
  notifications.length = 0;
  capturedRequests.length = 0;
  await registered.def.handler(args, makeCtx(ctxOptions));
  return notifications.map((n) => n.message).join("\n");
}

test("list shows the default models and notes no aggregator", async () => {
  const out = await run("list");
  assert.match(out, /Models:/);
  assert.match(out, /glm-5\.2 \(zai\/glm-5\.2:xhigh\)/);
  assert.match(out, /gpt-5\.5 \(openai-codex\/gpt-5\.5:xhigh\)/);
  assert.match(out, /No aggregator configured\./);
  assert.match(out, /built-in defaults/);
});

test("empty prompt and help show usage", async () => {
  const out = await run("");
  const help = await run("help");
  assert.match(out, /Usage: \/moa <prompt>/);
  assert.equal(out, help);
});

test("fan-out asks every model with projected context and the prompt appended", async () => {
  const out = await run("is my fix on track?");
  assert.match(out, /glm-5\.2 \(zai\/glm-5\.2:xhigh\):\nanswer from zai\/glm-5\.2/);
  assert.match(out, /gpt-5\.5 \(openai-codex\/gpt-5\.5:xhigh\):\nanswer from openai-codex\/gpt-5\.5/);
  assert.ok(!out.includes("Aggregated"));
  assert.equal(capturedRequests.length, 2);

  const ctx = capturedRequests[0].context;
  assert.equal(ctx.messages.length, 3);
  assert.equal(ctx.messages[0].content[0].text, "Fix the login bug");
  assert.equal(ctx.messages[1].content[0].text, "I will inspect auth.js.");
  assert.equal(ctx.messages[2].content[0].text, "is my fix on track?");
  assert.ok(!JSON.stringify(ctx).includes("SECRET CONTENT"));
  assert.match(ctx.systemPrompt, /independent second opinion/);
  assert.equal(capturedRequests[0].options.reasoning, "xhigh");
});

test("unknown model renders a failed section while the others still answer", async () => {
  const out = await run("check this", { models: new Set(["glm-5.2"]) });
  assert.match(out, /gpt-5\.5 failed: model not found: openai-codex\/gpt-5\.5/);
  assert.match(out, /glm-5\.2 \(zai\/glm-5\.2:xhigh\):\nanswer from zai\/glm-5\.2/);
});

test("aggregator renders a final merged section built from tagged opinions", async () => {
  writeFileSync(
    globalConfigPath,
    JSON.stringify({
      models: [{ name: "glm-5.2", provider: "zai", model: "glm-5.2", thinking: "xhigh" }],
      aggregator: { provider: "zai", model: "glm-5.2", thinking: "high" },
    }),
  );

  const out = await run("merge these");
  assert.match(out, /Aggregated \(zai\/glm-5\.2:high\):\nanswer from zai\/glm-5\.2/);
  assert.equal(capturedRequests.length, 2);

  const aggCtx = capturedRequests[1].context;
  assert.match(aggCtx.systemPrompt, /merging independent second opinions/);
  const lastMsg = aggCtx.messages[aggCtx.messages.length - 1];
  assert.equal(lastMsg.role, "user");
  assert.match(lastMsg.content[1].text, /<pi_moa_opinions>/);
  assert.match(lastMsg.content[1].text, /glm-5\.2:\nanswer from zai\/glm-5\.2/);
  assert.equal(capturedRequests[1].options.reasoning, "high");
});

test("legacy presets config fails with an error naming the new schema", async () => {
  writeFileSync(
    globalConfigPath,
    JSON.stringify({ defaultPreset: "architect", presets: { architect: {} } }),
  );

  const listOut = await run("list");
  assert.match(listOut, /legacy key\(s\)/);
  assert.match(listOut, /models/);
  assert.match(listOut, /aggregator/);

  const runOut = await run("anything");
  assert.match(runOut, /legacy key\(s\)/);
});

test("invalid JSON config surfaces the file path", async () => {
  writeFileSync(globalConfigPath, "{ not json");
  const out = await run("list");
  assert.match(out, /invalid JSON/);
  assert.match(out, /pi-moa-test-.*[\\/]moa\.json/);
});

test("project config is read only when the project is trusted", async () => {
  writeFileSync(
    globalConfigPath,
    JSON.stringify({ models: [{ name: "base", provider: "zai", model: "glm-5.2" }] }),
  );
  writeFileSync(
    projectConfigPath,
    JSON.stringify({
      models: [
        { name: "solo", provider: "zai", model: "glm-5.2", thinking: "low" },
        { name: "gone", provider: "zai", model: "missing-model" },
      ],
      aggregator: { provider: "zai", model: "glm-5.2" },
    }),
  );

  const untrusted = await run("list", { trusted: false });
  assert.match(untrusted, /base/);
  assert.ok(!untrusted.includes("solo"));

  const trusted = await run("list", { trusted: true });
  assert.match(trusted, /solo/);
  assert.match(trusted, /gone/);
  assert.ok(!trusted.includes("base"));
  assert.match(trusted, /aggregator: \(zai\/glm-5\.2\)/);

  rmSync(projectConfigPath, { force: true });
});

test("provider stream error renders a failed section", async () => {
  writeFileSync(
    globalConfigPath,
    JSON.stringify({ models: [{ name: "glm-5.2", provider: "zai", model: "glm-5.2" }] }),
  );
  const ctx = makeCtx();
  ctx.modelRegistry.streamSimple = () => ({
    result: async () => ({
      stopReason: "error",
      errorMessage: "rate limited",
      content: [],
    }),
  });
  notifications.length = 0;
  await registered.def.handler("try again", ctx);
  const out = notifications.map((n) => n.message).join("\n");
  assert.match(out, /glm-5\.2 failed: rate limited/);
});

test("setup rejected in the select dialog writes nothing", async () => {
  rmSync(globalConfigPath, { force: true });
  editorCalls = 0;
  await run("setup", { select: undefined });
  assert.equal(existsSync(globalConfigPath), false);
  assert.equal(editorCalls, 0);
});

test("setup cancelled in the editor writes nothing", async () => {
  rmSync(globalConfigPath, { force: true });
  editorCalls = 0;
  await run("setup", { select: "global", editor: undefined });
  assert.equal(existsSync(globalConfigPath), false);
  assert.equal(editorCalls, 1);
});

test("setup with an invalid edited config reports the error and writes nothing", async () => {
  rmSync(globalConfigPath, { force: true });
  editorCalls = 0;
  const out = await run("setup", { select: "global", editor: "{ not json" });
  assert.match(out, /invalid JSON/);
  assert.equal(existsSync(globalConfigPath), false);
  assert.equal(editorCalls, 1);
});

test("setup writes the edited config and the next invocation uses it", async () => {
  const edited = JSON.stringify({
    models: [{ name: "solo", provider: "zai", model: "glm-5.2" }],
  });
  const out = await run("setup", { select: "global", editor: edited });
  assert.match(out, /Saved MoA config/);

  assert.ok(existsSync(globalConfigPath));
  assert.equal(readFileSync(globalConfigPath, "utf8"), `${edited.trim()}\n`);

  const listOut = await run("list");
  assert.match(listOut, /solo \(zai\/glm-5\.2\)/);
  assert.match(listOut, /No aggregator configured\./);
});

test("setup warns when saving a project config in an untrusted project", async () => {
  const out = await run("setup", {
    trusted: false,
    select: "project",
    editor: JSON.stringify({ models: [{ provider: "zai", model: "glm-5.2" }] }),
  });
  assert.match(out, /Saved MoA config/);
  assert.match(out, /not trusted/);
  assert.ok(existsSync(projectConfigPath));
  rmSync(projectConfigPath, { force: true });
});
