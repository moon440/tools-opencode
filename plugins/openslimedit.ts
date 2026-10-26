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

// OpenSlimedit adapter for OpenCode 2.x.
//
// Shortens stable built-in tool descriptions. Tool names, schemas, and
// parameters remain unchanged, so this preserves model capability while
// reducing the fixed prefix sent with every request.

const SLIM_DESCRIPTIONS: Record<string, string> = {
  read: "Read file or directory.",
  glob: "Find files by glob.",
  grep: "Search file contents.",
  edit: "Replace exact text or a line range.",
  write: "Create or replace a file.",
  patch: "Apply a multi-file patch.",
  shell: "Run a host shell command.",
  bash: "Run a host shell command.",
  webfetch: "Fetch a URL as text, markdown, or HTML.",
  websearch: "Search the selected web provider.",
  question: "Ask the user a question.",
  skill: "Load a skill.",
  subagent: "Run a configured subagent.",
}

export default {
  id: "openslimedit",

  async setup(ctx: any) {
    await ctx.tool.transform((editor: any) => {
      for (const [toolID, description] of Object.entries(SLIM_DESCRIPTIONS)) {
        editor.update(toolID, (tool: any) => {
          tool.description = description
        })
      }
    })
  },
}
