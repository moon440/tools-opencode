# Novelty and usefulness

## What is genuinely novel

### 1. `cache-warden`: activity-aware warming

OpenCode's native warming uses a fixed idle timer:

```text
first ping after 4 minutes
repeat every 4 minutes
for 30 minutes
regardless of session value
```

The existing cache-warming idea is not novel by itself. Several community
keep-alive plugins use fixed or near-fixed ping intervals.

What is novel here is the decision logic:

```text
only warm a session whose previous assistant request had a large cache-read hit
use cached-token size as a cost filter
skip subagents and small contexts
cancel all pending pings when a real prompt or tool loop starts
stop at a bounded number of pings
use transient session generation instead of native user prompts
```

This turns warming from "always on" into an economic action:

```text
expected saved miss cost > expected warm-ping cost
```

For `qwen3.8-flash`:

```text
normal input: $0.15 / 1M
cache read:   $0.016 / 1M
```

A full cache miss costs roughly:

```text
1M context: $0.15
```

A warm ping costs roughly:

```text
1M cached context: $0.016
```

The break-even is about nine and a half warm pings per full miss. Four pings are
therefore a reasonable conservative window.

This is the most technically interesting plugin in the repository.

## What is useful but not fundamentally new

### 2. `context-mode-safe-router`

This is an OpenCode 2.x compatibility and cache-safety fix.

Context Mode normally tries to route behavior through hooks and prompt
instructions. Those mechanisms can increase fixed context or mutate prompt
prefixes. In OpenCode 2.x, a prompt-mutating adapter can trigger provider cache
misses.

The useful contribution is:

```text
permission-hook enforcement instead of system-prompt enforcement
no per-request prompt mutation
large-read and raw-download blocking
local secret-path blocking
Context Mode guidance returned in denial messages
```

This is practical and important for v2, but it is a compatibility adapter rather
than a new product.

## Other useful components

### 3. `openslimedit`

Compresses built-in tool descriptions while preserving schemas.

```text
novelty: low
usefulness: moderate
```

OpenSlimedit already exists upstream. This project only provides an OpenCode 2.x
plugin-shape adapter.

### 4. `cost-guard`

Persistent slash commands for:

```text
/cost status
/cost warm
/cost mcp
/cost compact
```

```text
novelty: low
usefulness: high
```

It is useful because cost decisions should be reversible from inside OpenCode
without editing files manually.

### 5. `rea-toggle`

Runtime MCP on/off command.

```text
novelty: low
usefulness: high for users with heavy optional MCP servers
```

MCP reconnects can rebuild the cache prefix. The plugin gives users explicit
control instead of leaving heavy optional servers permanently active.

## Who should use it

Useful for:

```text
long OpenCode sessions
low-cache-rate providers
OpenAI-compatible gateways
users with MCP servers that change tools
users paying per token on Hyper/DeepSeek/Qwen/GLM
agents that read large logs or web pages
multi-agent local coding setups
```

Less useful for:

```text
short one-shot prompts
sessions under about 30k context
providers with very long cache TTL
users who never install plugins
OpenCode users with free model plans
```

## Honest limitation

These tools lower waste. They do not make every request identical.

Realistic cached request price still depends on:

```text
new prompt length
tool output length
reasoning output length
number of tool-loop steps
active MCP schemas
image/attachment size
compaction frequency
provider cache TTL
cache routing changes
model switch
config reload
```

The best stable result for the tested environment is about:

```text
$0.004-$0.006 per cached assistant request
```

At 300k-330k context. Larger contexts and longer answers cost more. Smaller new
sessions cost less.
