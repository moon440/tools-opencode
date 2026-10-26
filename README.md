# tools-opencode

OpenCode 2.x plugins and templates for lowering token/cache cost while keeping
agents capable.

AGPL-3.0-only.

## What this repository contains

```text
plugins/
  context-mode-safe-router.ts
  opencode-cost-suite.ts
examples/
  hyper-cost-effective.opencode.jsonc
docs/
  COST_MODEL.md
  SECURITY.md
tests/
  verify.mjs
```

## Design rules

These plugins do not mutate the system prompt.

They avoid:

```text
system.transform
session context injection
resume snapshot injection
compaction prompt injection
dynamic per-request prompt text
```

This is important for OpenAI-compatible providers that use prefix caching. If
the stable beginning of a request changes, the provider may bill the whole
context as uncached input.

## Plugins

### `context-mode-safe-router`

Blocks or redirects wasteful tool calls:

```text
raw webfetch
curl / wget stdout
large native file reads
local credential paths
```

It does not disable Context Mode. It routes the agent toward:

```text
ctx_execute
ctx_execute_file
ctx_fetch_and_index
ctx_index
ctx_search
```

### `opencode-cost-suite`

One plugin replacing `openslimedit`, `cost-guard`, `cache-warden`, and
`rea-toggle`.

Slim tool descriptions:

Shortens stable built-in tool descriptions. Tool names and schemas of kept
tools remain unchanged, so the request prefix stays identical between chats.

Fixed-prefix pruning:

Removes diagnostic tool schemas that cost input tokens in every new session
and every cache miss:

```text
browser.trace.*  browser.cpu.*  browser.heap.*
browser.network.*  browser.files.*  browser.lighthouse
ctx_insight  ctx_doctor  ctx_upgrade  ctx_stats  ctx_purge
```

Browser core tools (preview, tabs, navigate, screenshot, clicks, evaluate)
stay enabled for the Review tab workflow. Pruning happens inside the tool
transform, so newly connected MCP servers are pruned on registry replay with
no config churn.

Limitation: desktop client-side tool namespaces (browser, IRC integrations)
are not registered in the server tool registry and cannot be pruned by
plugins. They appear in the Code Mode tool index with signatures, not full
schemas. Measure their real prefix cost with `/cost task` in a fresh chat
before attempting any workaround.

Telemetry:

Every assistant step appends a numeric line (tokens, cache read, cost, model)
to `~/.local/share/opencode/cost-suite/usage.jsonl`. No prompts, no file
contents, no session titles.

Commands:

```text
/cost status            config, MCP, warden arming, evidence
/cost task              this session: steps, input, cache read, cost, largest step
/cost report            top sessions by cost from the usage log
/cost warm on|off       native warming in global config
/cost mcp <name> on|off
/cost compact
/warden status|on|off|reset
/rea on|off
```

Adaptive cache warden:

Warms only after real idle, only when the last real assistant request had at
least 30,000 cache-read tokens, at 4/8/12/16 minutes, max four pings, 20
minute window, skipping subagents.

Evidence-driven arming. Idle resumes are classified as
`hit-unwarmed`, `hit-warmed`, `miss-warmed`, or `miss-unwarmed` in
`warden.json`:

```text
3+ idle resumes all hit the cache   -> warming disarms (stable, stop paying)
2+ warmed misses, no warmed hit     -> warming disarms (ineffective)
any observed miss                   -> warming arms
/warden on|off                      -> manual override
/warden reset                       -> forget evidence
```

## Install

Copy plugins into OpenCode's global plugin directory:

```text
~/.config/opencode/plugins/
```

or into a project:

```text
.opencode/plugins/
```

Restart or reload OpenCode:

```sh
opencode service restart
```

## Recommended Hyper model default

Use:

```text
hyper/qwen3.8-flash
```

Current published pricing:

```text
input:       $0.15 / 1M
output:      $0.47 / 1M
cache read:  $0.016 / 1M
cache write: $0 / 1M
```

Use `qwen3.8-27b` or another reasoning model only for hard tasks:

```text
hyper/qwen3.8-27b
```

Do not keep a very long stale session alive forever. Long sessions accumulate
context and make every cached request expensive.

Recommended agent variants:

```text
build:       hyper/qwen3.8-flash#medium
plan:        hyper/qwen3.8-flash#medium
general:     hyper/qwen3.8-flash#medium
explore:     hyper/qwen3.8-flash#medium
title:       hyper/qwen3.8-flash#low
summary:     hyper/qwen3.8-flash#low
compaction:  hyper/qwen3.8-flash#low
```

## Measured stable price target

Isolated small new session:

```text
one status-check assistant step: $0.00084
about 0.017 Hypercredits
```

For the tested `hyper/qwen3.8-flash #medium` setup, a stable cached session
around 300k-330k context produced:

```text
median cached assistant request: $0.0053
typical cached range:            $0.0045-$0.0060
full 310k cache miss:            $0.047
full 783k cache miss:            $0.118
```

In Hypercredits, assuming `1 credit = $0.05`:

```text
stable cached assistant request: about 0.10-0.12 credits
310k miss:                       about 0.94 credits
783k miss:                       about 2.36 credits
```

Do not confuse one assistant request with one user prompt. A user prompt can
produce several assistant tool-loop steps.

The practical stable target is:

```text
new small session step:         $0.0008-$0.0015
normal cached work step:        $0.0025-$0.0050
large audit session step:       $0.0045-$0.0060
complex step with huge output:  $0.0060-$0.0100+
cache-prefix rebuild:           context tokens * $0.15 / 1M
```

A full user task cost is:

```text
number of assistant/model steps * average step cost
```

## More documentation

```text
docs/COST_MODEL.md
docs/AUDIT-2026-10-26.md
docs/NOVELTY.md
docs/SECURITY.md
```

When warming is enabled, one provider request is real usage. It should be used
only when the previous context is large enough that a cache miss costs more
than several warm requests.

## Security notes

See `docs/SECURITY.md`.

Important:

```text
Do not include opencode.db
Do not include opencode.db-wal
Do not include service.json
Do not include logs
Do not run auth export and share its output
Do not share pairing links
Rotate any API key that appeared in chat or logs
```

OpenCode shell tools run with the local user's filesystem and network authority.
Permission rules reduce agent mistakes but are not a full OS sandbox.
