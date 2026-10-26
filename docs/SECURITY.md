# Security notes

## Local API service

OpenCode 2.x uses a local HTTP background service. The CLI and desktop app talk
to it over loopback.

Service state can contain a local API password. Keep files private:

```text
~/.config/opencode/service.json
~/.local/state/opencode/service.json
~/.local/share/opencode/opencode.db
~/.local/share/opencode/log/
```

Do not share these files with a bug report. Redact before posting.

## Remote pairing

The remote URL is not enough by itself. OpenCode exposes the service through an
encrypted tunnel route. Remote access requires a short-lived pairing code or
your server password.

Still treat remote access as dangerous because:

```text
OpenCode can read files
OpenCode can edit files
OpenCode shell runs as your user
MCP servers can run local code
plugins can run local code
```

If a pairing link leaks, revoke it by restarting/regenerating remote access or
rotating the service password. Do not rely on the URL being secret.

## Charm Hyper API key

Charm Hyper uses an OpenAI-compatible API.

Current integration:

```text
provider ID:       hyper
integration ID:    hyper
endpoint:          https://hyper.charm.land/v1
package:           @opencode/ai/providers/openai-compatible
supported auth:    saved key or HYPER_API_KEY
```

Public model list:

```text
GET https://hyper.charm.land/v1/models
```

Chat:

```text
POST https://hyper.charm.land/v1/chat/completions
```

The Hyper response can include cost and remaining credits. Do not log raw
request bodies because tool outputs and file contents may contain secrets.

If an API key appears in a session, log, screenshot, database, or exported
transcript, rotate it. Redaction in history is not enough because old local
transcripts may remain.

## Prompt-cache key

`providers.hyper.settings.setCacheKey: true` tells OpenCode to send a stable
prompt cache key for the Hyper provider. The key is for cache routing/accounting
and is not a substitute for secret hygiene.

## Permission boundaries

OpenCode permissions protect agent tool calls:

```text
read
edit
write
shell
webfetch
websearch
skill
subagent
external_directory
mcp tools
```

They do not protect against:

```text
malicious local files
malicious plugins
malicious MCP servers
shell commands executed outside OpenCode
OS-level compromise
browser profile extraction through shell
```

Use narrow allowlists and deny secrets from agent-readable paths.

## Public repository hygiene

Before pushing public tool configurations, search for:

```text
API keys
tokens
Authorization
service.json
password
secret
credential
personal absolute paths
project-specific private directories
session IDs
log dumps
database files
screenshots
browser profiles
Telegram exports
.env files
SSH keys
GitHub tokens
```

Use sanitized examples only.
