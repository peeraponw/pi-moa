# pi-moa

Second-opinion command for pi. `/moa <prompt>` asks every configured model the
same question in parallel and shows each answer labeled with its model. An
optional aggregator can merge the answers into one final take.

## What it does

- `/moa <prompt>` fans out to all configured models in parallel.
- Each model sees the session's user and assistant text, without tool schemas
  or tool results, plus your prompt as the final message.
- Every answer renders as its own labeled section. A failed model renders as
  an error section, so the others still show.
- When an aggregator is configured, it receives the same conversation with the
  opinions appended in a tagged block, and its merged answer renders last.
- Output is display only. Nothing is injected into the session transcript, and
  no provider or model is registered or switched.
- Config is read on each invocation, so edits take effect without a reload.

## Install

```bash
pi install npm:@peeraponw/pi-moa
```

Or try without installing:

```bash
pi -e npm:@peeraponw/pi-moa
```

You can also install straight from GitHub:

```bash
pi install git:github.com/peeraponw/pi-moa
```

## Configure

Run:

```text
/moa setup
```

Pick global or project, then edit the JSON in the editor. The default config
uses `zai/glm-5.2:xhigh` and `openai-codex/gpt-5.5:xhigh` with no aggregator:

```json
{
  "models": [
    { "name": "glm-5.2", "provider": "zai", "model": "glm-5.2", "thinking": "xhigh" },
    { "name": "gpt-5.5", "provider": "openai-codex", "model": "gpt-5.5", "thinking": "xhigh" }
  ]
}
```

Schema:

- `models` (required, at least one entry). Each entry:
  - `name` (optional): label shown in the output.
  - `provider`, `model` (required): model reference, as in `/model`.
  - `thinking` (optional): `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
  - `maxTokens`, `temperature` (optional).
- `aggregator` (optional): same shape as a model entry, minus `name`. Its
  answer renders as the final section. Set it to `null` in a project config to
  remove a global aggregator.

Config files:

- global: `~/.pi/agent/moa.json`
- project override: `.pi/moa.json`, read only when the project is trusted

A project `models` array replaces the global one wholesale. Project-level
`aggregator` replaces or removes the global aggregator.

Configs from older versions with `presets` fail validation with an error that
names the new schema.

## Use

```text
/moa is this migration plan sound?
/moa list
/moa setup
/moa help
```

`/moa <prompt>` needs your configured providers to have working auth, the same
as running them as your session model.

## Reserved words

Prompts whose first word is `setup`, `list`, or `help` are treated as those
commands, so such a prompt needs rephrasing.
