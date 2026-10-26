/*
 * tools-opencode
 * Copyright (C) 2026 tools-opencode contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, version 3.

 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.

 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/agpl.txt>.
 */

// Cost Guard automation for OpenCode 2.x.
//
// Persistent settings live in the global opencode.json(c) file. This plugin
// does not mutate prompts or session context. It only changes configuration and
// MCP server state explicitly requested through slash commands.

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

function configDirectory(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
}

function configPath(): string {
  const dir = configDirectory()
  const jsonc = join(dir, "opencode.jsonc")
  const json = join(dir, "opencode.json")
  if (existsSync(jsonc)) return jsonc
  if (existsSync(json)) return json
  return json
}

function cleanJsonc(text: string): string {
  let output = ""
  let inString = false
  let quote = ""
  let escaped = false

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const next = text[i + 1]

    if (inString) {
      output += ch

      if (escaped) {
        escaped = false
      } else if (ch === "\\") {
        escaped = true
      } else if (ch === quote) {
        inString = false
      }

      continue
    }

    if (ch === '"' || ch === "'") {
      inString = true
      quote = ch
      output += ch
      continue
    }

    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1
      output += "\n"
      continue
    }

    if (ch === "/" && next === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1
      i += 1
      continue
    }

    output += ch
  }

  return output.replace(/,(\s*[}\]])/g, "$1")
}

function readConfig(): any {
  const path = configPath()
  if (!existsSync(path)) return {}
  return JSON.parse(cleanJsonc(readFileSync(path, "utf8")))
}

function writeConfig(config: any): string {
  const path = configPath()
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8")
  return path
}

function commandArgs(text: string): string[] {
  return String(text ?? "").trim().split(/\s+/).filter(Boolean)
}

function truthy(value: string): boolean | null {
  const normalized = value.toLowerCase()
  if (normalized === "on" || normalized === "true" || normalized === "enable") return true
  if (normalized === "off" || normalized === "false" || normalized === "disable") return false
  return null
}

export default {
  id: "opencode-cost-guard",

  async setup(ctx: any) {
    async function reply(sessionID: string, text: string) {
      await ctx.session.prompt({
        sessionID,
        text,
        delivery: "queue",
      })
    }

    async function setWarming(sessionID: string, enabled: boolean) {
      const config = readConfig()

      config.warming = enabled
        ? {
            interval: "4 minutes",
            duration: "20 minutes",
          }
        : false

      const path = writeConfig(config)
      await reply(
        sessionID,
        enabled
          ? `Warming enabled automatically: first request after 4 idle minutes, window lasts 20 minutes. Config: ${path}. One cache miss on restart/config reload is normal.`
          : `Warming disabled. Idle cache expiry may now cause occasional full-input rewrites. Config: ${path}.`
      )
    }

    async function setMcp(sessionID: string, name: string, enabled: boolean) {
      const config = readConfig()
      const server = config.mcp?.servers?.[name]

      if (!server) {
        await reply(sessionID, `MCP server not found in global config: ${name}.`)
        return
      }

      server.disabled = !enabled
      const path = writeConfig(config)
      await reply(
        sessionID,
        `${name} MCP ${enabled ? "enabled" : "disabled"}. This intentionally changes the tool-prefix once; the next request may pay a cache miss, then normal cache reuse resumes. Config: ${path}.`
      )
    }

    async function status(sessionID: string) {
      const config = readConfig()
      const servers = await ctx.mcp.list()
      const warming = config.warming === undefined ? false : config.warming
      const wardenMarker = join(configDirectory(), "cache-warden.disabled")
      const wardenEnabled = !existsSync(wardenMarker)

      await reply(
        sessionID,
        [
          "Cost Guard status",
          `default model: ${config.model ?? "session-selected"}`,
          `native warming: ${JSON.stringify(warming)}`,
          `adaptive cache warden: ${wardenEnabled ? "enabled" : "disabled"}`,
          `warden marker: ${wardenMarker}`,
          `MCP state: ${JSON.stringify(servers)}`,
          "Commands: /cost warm on|off, /cost mcp <name> on|off, /warden on|off|status, /cost compact",
        ].join("\n")
      )
    }

    await ctx.command.transform((editor: any) => {
      editor.add({
        name: "cost",
        description: "Inspect or toggle persistent OpenCode cost settings: /cost status | warm | mcp | compact",
        async execute({ sessionID, prompt }: any) {
          const args = commandArgs(prompt?.text)
          const command = args[0]?.toLowerCase()

          if (!command || command === "status") {
            await status(sessionID)
            return
          }

          if (command === "warm") {
            const enabled = truthy(args[1] ?? "")
            if (enabled === null) {
              await reply(sessionID, "Usage: /cost warm on | /cost warm off")
              return
            }
            await setWarming(sessionID, enabled)
            return
          }

          if (command === "mcp") {
            const name = args[1]
            const enabled = truthy(args[2] ?? "")
            if (!name || enabled === null) {
              await reply(sessionID, "Usage: /cost mcp <server-name> on | off")
              return
            }
            await setMcp(sessionID, name, enabled)
            return
          }

          if (command === "compact") {
            await ctx.session.compact({ sessionID })
            await reply(sessionID, "Compaction requested for this session.")
            return
          }

          await reply(
            sessionID,
            "Cost Guard usage:\n/cost status\n/cost warm on|off\n/cost mcp <server> on|off\n/cost compact"
          )
        },
      })
    })
  },
}
