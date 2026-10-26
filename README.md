tools-opencode
==============

Two OpenCode 2.x plugins that keep the money questions out of your prompts.

    plugins/cost.ts     slim tool descriptions, prune junk schemas, per-step
                        cost log, cache warmer with an evidence budget
    plugins/router.ts   permission checks that block fat reads and raw web
                        traffic; points the agent at Context Mode instead

Why: on OpenAI-compatible providers the request prefix gets prompt-cached.
A new chat pays full input price for the whole stable prefix; a cache miss
re-bills it. On qwen3.8-flash through Hyper that's $0.15 per million input
tokens versus $0.016 cached, so shrinking the prefix and not breaking it is
most of the game. docs/COSTS.md has the measured numbers and the math.


install
-------

Copy both files into your global plugin dir:

    ~/.config/opencode/plugins/

Restart OpenCode (desktop: quit and reopen; CLI: opencode service restart).
No dependencies, no network, no build step. Two files, that's the whole
runtime. Everything is plain OpenCode 2.x plugin API.


commands
--------

    /cost status            config, MCP state, warden arming + evidence
    /cost task              this session: steps, tokens, cache, cost
    /cost report            top sessions by cost from the usage log
    /cost warm on|off       native warming (you usually want the warden)
    /cost mcp <name> on|off config toggle; expect one cache miss
    /cost compact           compact now
    /warden status|on|off|reset
    /rea on|off             heavy reverse-engineering MCP, off by default

Telemetry lands in ~/.local/share/opencode/cost-suite/ as numeric JSONL.
Token counts and cents. No prompts, no file contents, no titles. Delete the
directory whenever you like; nothing else reads it.


rules of the house
------------------

These plugins exist so that I stopped paying for my own habits. They hold
to a few rules that you should keep too if you fork:

1. The system prompt is never touched. No system.transform, no context
   injection, nothing dynamic at the front of the request. Move the prefix
   and the provider rebills all of it.
2. Schema changes happen once, then freeze. Toggling an MCP server mid-work
   costs a full prefix rebuild. /cost mcp says so before it does it.
3. Warming must earn its keep. The warden classifies every idle resume as
   hit/miss with/without pings (warden.json), warms only sessions whose last
   real step had >= 30k cached tokens, and disarms itself when the cache
   survives idle without help, or when pings demonstrably failed to save a
   miss. Four pings (~$0.02) must beat one 300k miss (~$0.047) or they are
   off. That ratio is provider-specific; tune it, don't trust my defaults.
4. OpenCode is not a sandbox. The router stops the agent from doing stupid
   things with credentials; a determined shell still runs as you. Don't
   paste logs, opencode.db, or service.json into bug reports; docs/SECURITY.md
   has the short list.


measured, not promised
----------------------

Real numbers from the desktop build, same day I wrote this:

    fixed prefix after pruning:     ~25k tokens shorter than before
    cached step at 150k prefix:     $0.0026-$0.0029
    fresh small session step:       ~$0.0008
    310k full cache miss:           $0.047
    1 hypercredit:                  $0.05

The old v1 event names (message.updated, session.idle) never fire on this
build. The first warden I wrote was dead code listening to them for days.
cost.ts maps the real v2 payloads (session.step.ended, event.data) and
dedups with durable sequence ids because the desktop runs one plugin
instance per location and they all see one bus. If you port this to another
host, re-run the event capture in tests first; build names lie.


hacking
-------

    node tests/verify.mjs

loads the plugin, checks the prune patterns, the slim map, the warming
economics rules, and greps shipped files for secrets and personal paths
(that last one has caught me being sloppy twice).

Send patches the old way: a branch and a PR, or just fix your copy and
don't tell anyone. No CLA, no process. AGPL-3.0-only, see LICENSE.
