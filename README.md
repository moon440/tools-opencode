# tools-opencode

OpenCode 2.x plugins and templates for lowering token/cache cost while keeping
agents capable.

AGPL-3.0-only.

## What this repository contains

```text
plugins/
  context-mode-safe-router.ts
  openslimedit.ts
  cost-guard.ts
  cache-warden.ts
  rea-toggle.ts
examples/
  hyper-cost-effective.opencode.jsonc
docs/
  COST_MODEL.md
  SECURITY.md
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

### `openslimedit`

Shortens stable built-in tool descriptions. Tool names and schemas remain
unchanged.

### `cost-guard`

Persistent slash commands:

```text
/cost status
/cost warm on|off
/cost mcp <server> on|off
/cost compact
```

It edits global OpenCode config only when explicitly requested.

### `cache-warden`

Adaptive prompt-cache warmer.

Default behavior:

```text
enabled
minimum previous cache read: 30,000 tokens
first warm ping: 4 minutes after idle
ping interval: 4 minutes
maximum pings: 4
idle window: 20 minutes
```

It listens to OpenCode events and only warms a session when the previous real
assistant request had a large cached prefix. It skips tiny sessions, subagents,
and sessions that become busy.

Commands:

```text
/warden status
/warden on
/warden off
```

### `rea-toggle`

Adds:

```text
/rea on
/rea off
```

Useful for keeping a heavy reverse-engineering MCP server out of normal
sessions.

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

## Measured stable price target

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
$0.005 per cached assistant request under a long audit session
```

New small sessions should be much cheaper. A large miss should happen only after
model/MCP/config/tool-prefix changes or provider cache expiry.

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
