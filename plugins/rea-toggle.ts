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

// REA MCP toggle command for OpenCode 2.x.
//
// REA is disabled by default to keep tool schemas out of cached context.
// Use `/rea on` when reverse-engineering tools are needed.
// Use `/rea off` to disable it again.

export default {
  id: "rea-toggle",

  async setup(ctx: any) {
    async function setEnabled(enabled: boolean) {
      await ctx.mcp.transform((editor: any) => {
        editor.update("rea", (server: any) => {
          server.disabled = !enabled
        })
      })
      await ctx.mcp.reload()
    }

    await ctx.command.transform((editor: any) => {
      editor.add({
        name: "rea",
        description: "Enable or disable REA MCP: /rea on | /rea off",
        async execute({ sessionID, prompt }: any) {
          const arg = String(prompt?.text ?? "").trim().toLowerCase()

          if (arg === "on" || arg === "enable") {
            await setEnabled(true)
            await ctx.session.prompt({
              sessionID,
              text: "REA enabled. Use reverse-engineering tools when needed.",
              delivery: "queue",
            })
            return
          }

          if (arg === "off" || arg === "disable") {
            await setEnabled(false)
            await ctx.session.prompt({
              sessionID,
              text: "REA disabled. Tool schemas removed from future context.",
              delivery: "queue",
            })
            return
          }

          await ctx.session.prompt({
            sessionID,
            text: "Usage: `/rea on` enables REA. `/rea off` disables REA.",
            delivery: "queue",
          })
        },
      })
    })
  },
}
