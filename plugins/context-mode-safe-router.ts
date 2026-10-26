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

// Context Mode routing adapter for OpenCode 2.x.
//
// Cache-safe design:
// - no system-prompt transform
// - no session/context/compaction hook
// - no tool-description mutation
// - permission evaluation only
//
// It blocks the tool calls most likely to add large raw data to the cached
// conversation prefix, then tells the model which Context Mode tool to use.

import { statSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"

const READ_LIMIT_BYTES = Number(
  process.env.OPENCODE_CONTEXT_MODE_READ_LIMIT_BYTES ?? "50000"
)

function canonicalize(value: unknown): string {
  return String(value ?? "").replaceAll("\\", "/").toLowerCase()
}

function normalizePath(resource: string): string {
  let value = resource.trim()
  if (value.startsWith("~/") || value === "~") {
    value = homedir().replaceAll("\\", "/") + value.slice(1)
  }
  return canonicalize(resolve(value))
}

function isProtectedPath(resource: string): boolean {
  const path = normalizePath(resource)
  const home = canonicalize(homedir())

  const roots = [
    `${home}/.ssh/`,
    `${home}/.aws/`,
    `${home}/.azure/`,
    `${home}/.config/gh/`,
    `${home}/.config/opencode/service.json`,
    `${home}/.local/share/opencode/opencode.db`,
    `${home}/.local/share/opencode/log/`,
    `${home}/appdata/roaming/microsoft/credentials/`,
    `${home}/appdata/local/google/chrome/user data/`,
    `${home}/appdata/local/microsoft/edge/user data/`,
  ]

  return roots.some((root) => path.startsWith(root))
}

function isRawDownloadCommand(resource: string): boolean {
  return /(^|\s|&&|\||\;)(curl(\.exe)?|wget(\.exe)?)\s/i.test(String(resource ?? ""))
}

function isLargeRead(resource: string): boolean {
  if (!resource || resource.includes("*") || resource.includes("?")) {
    return false
  }

  try {
    const status = statSync(resolve(resource))
    return status.isFile() && status.size > READ_LIMIT_BYTES
  } catch {
    return false
  }
}

export default {
  id: "context-mode-safe-router",

  async setup(ctx: any) {
    await ctx.permission.hook("evaluate", async (event: any) => {
      const action = String(event?.action ?? "")
      const resources = Array.isArray(event?.resources)
        ? event.resources.map(String)
        : []

      const block = (message: string) => {
        event.effect = "deny"
        event.message = message
      }

      if (action === "webfetch") {
        block(
          "Context Mode: webfetch is blocked so raw page bytes do not enter the cached context. " +
            "Use ctx_fetch_and_index(url, source), then ctx_search(queries), or ctx_execute for one derived answer."
        )
        return
      }

      if (action === "shell" && resources.some(isRawDownloadCommand)) {
        block(
          "Context Mode: curl and wget stdout can bypass context limits. " +
            "Use ctx_execute or ctx_fetch_and_index so only a derived summary enters the model context."
        )
        return
      }

      if ((action === "read" || action === "edit") && resources.some(isProtectedPath)) {
        block(
          "Context Mode security router: protected local credential or OpenCode state path. " +
            "Use an environment variable or ask the user for a sanitized value."
        )
        return
      }

      if (action === "read" && resources.some(isLargeRead)) {
        block(
          `Context Mode: file exceeds ${READ_LIMIT_BYTES} bytes. ` +
            "Use ctx_execute_file(path, language, code) to process it locally, or ctx_index and ctx_search for later retrieval."
        )
      }
    })
  },
}
