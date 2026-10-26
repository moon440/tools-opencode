# Cost and cache model

OpenCode bills per model request. Cache hits are cheaper than normal input, but
they are not free. The goal is to maximize cache hit percentage while keeping
the active context as small as practical.

## Prefix cache rule

Providers generally cache the beginning of the prompt. A request reuses cache
when the model, stable system prefix, tools, and message prefix remain the same.

A cache hit can still be broken by:

```text
config reload
MCP server connect/disconnect
tool set change
system prompt mutation
model change
compaction
provider routing/cold cache
cache TTL expiry
```

The first request after one of those events may pay full input price. Repeated
full-price requests mean the stable prefix keeps changing.

## Hyper pricing example

`hyper/qwen3.8-flash`:

```text
input:       $0.15 / 1M
output:      $0.47 / 1M
cache read:  $0.016 / 1M
cache write: $0 / 1M
```

At 800,000 context tokens:

```text
uncached request: roughly $0.12 + output
cached request:   roughly $0.0128 + new input + output
```

Cache saves about 90% of large-context input cost.

## When warming helps

Warming sends a real model request. It preserves provider cache but consumes
cache tokens.

For Qwen3.8 Flash, one 800k warm request costs about:

```text
800,000 * $0.016 / 1M = $0.0128
```

One uncached 800k request costs about:

```text
800,000 * $0.15 / 1M = $0.12
```

Four warm pings cost about:

```text
4 * $0.0128 = $0.0512
```

Warming is reasonable when it prevents at least one full-input miss for a large
session.

Warming is poor when:

```text
context is under 30k tokens
user will not return soon
user sends prompts less than 4 minutes apart
tool/MCP state keeps changing
session should be replaced by a new session
```

## Adaptive cache warden

The cache-warden plugin uses this heuristic:

```text
warm only after an idle agent loop
warm only if last assistant request had at least 30k cache-read tokens
warm at 4, 8, 12, and 16 minutes of idleness
stop at 20 minutes
stop after 4 pings
reset on any real user/assistant activity
```

This is more efficient than always-on fixed warming because it avoids warming
small sessions and long idle periods where the saved money is not worth a ping.

## Practical cost controls

1. Start a new session after a long audit or task.
2. Keep tool schemas stable.
3. Use Context Mode for large files, logs, and web pages.
4. Keep `tool_output.max_bytes` moderate; too low causes repeated commands.
5. Use terse response styles such as Caveman.
6. Use RTK or equivalent command output compression.
7. Disable heavy MCP servers by default and enable them only when needed.
8. Use flash model for most work and escalate hard reasoning separately.
9. Manual compaction when switching to a new phase.
10. Do not repeatedly read the same large files.

## Model selection

Best general default on Charm Hyper for long agentic coding sessions:

```text
hyper/qwen3.8-flash #medium
```

Hard-reasoning alternatives:

```text
hyper/qwen3.8-27b
hyper/qwen3.8-max
hyper/deepseek-v4.1-flash
hyper/glm-5.3-flash
```

Cheapest low-output model:

```text
hyper/gemma-4-26b-a4b-it
```

It has cheaper input than Qwen flash but less agentic capability and no
advanced reasoning variants. Do not use it as the main coding brain if task
quality matters.

Cache-read value matters in long sessions. Qwen flash currently has one of the
best cache-read prices in the Hyper catalog.
