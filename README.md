# pi-moa

Mixture-of-agents workflow for pi, adapted from Hermes MoA for coding-agent use.

## What it adds

- A normal `moa` model provider with one model per preset.
- A `/moa [preset] <prompt>` one-shot command that restores your previous model.
- Advisor/reference models run on manual MoA invocations, not every tool-result turn.
- Normal-model turns get guidance to ask before using MoA for unusually complex work.
- Advisors see only user/assistant text, without tool schemas or tool results.
- The aggregator keeps normal pi tools and acts as the real coding agent.
- Advisor outputs are visible as a collapsible thinking block and filtered from future context.
- Global config plus optional project override.

## Install locally

From this directory:

```bash
pi install .
```

Or try without installing:

```bash
pi -e .
```

## Configure

Run:

```text
/moa setup
```

The default generated config uses:

- advisors: `zai/glm-5.2:xhigh`, `openai-codex/gpt-5.5:xhigh`
- aggregator: `zai/glm-5.2:high`
- presets: `default`, `architect`, `bug`, `review`, `plan`, `debug`

Config files:

- global: `~/.pi/agent/moa.json`
- project override: `.pi/moa.json`

Reload after editing:

```text
/moa reload
```

## Use

One-shot:

```text
/moa architect design the migration
/moa bug find the race condition
/moa review review my current diff
```

Persistent model selection:

```text
/model architect --provider moa
```

With a persistent MoA model, advisors run on user-facing turns and are skipped on
follow-up tool-result turns. Their latest advice is reused privately during the
same tool loop, so tools stay cheaper without losing the manual MoA guidance.

List presets:

```text
/moa list
```
