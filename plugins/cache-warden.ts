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

// Adaptive prompt-cache warmer for OpenCode 2.x.
//
// This replaces fixed native warming with usage-aware warming:
// - starts only after a real agent loop becomes idle
// - warms only sessions whose last provider request already has a large cache prefix
// - skips subagents and tiny sessions
// - stops after four pings or 20 minutes since the last real request
// - uses ctx.session.generate, so warming is transient and does not append history
//
// The default state is enabled. Create:
//   ~/.config/opencode/cache-warden.disabled
// to turn it off without editing this file.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const IDLE_START_MS = 4 * 60_000
const WARM_INTERVAL_MS = 4 * 60_000
const IDLE_WINDOW_MS = 20 * 60_000
const MAX_ATTEMPTS = 4
const MIN_CACHED_TOKENS = 30_000
const WARM_PROMPT = "Do not perform any work. Reply with exactly: OK"

function markerPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(configHome, "opencode", "cache-warden.disabled")
}

function isEnabled(): boolean {
  return !existsSync(markerPath())
}

function setEnabled(enabled: boolean): string {
  const path = markerPath()
  mkdirSync(dirname(path), { recursive: true })

  if (enabled) {
    if (existsSync(path)) unlinkSync(path)
    return path
  }

  writeFileSync(path, "disabled by /cost warden off\n", "utf8")
  return path
}

type SessionState = {
  sessionID: string
  providerID?: string
  modelID?: string
  lastRealAt: number
  lastCacheRead: number
  lastCost: number
  warmUntil: number
  attempts: number
  timer?: ReturnType<typeof setTimeout>
  warming: boolean
  lastWarmAt: number
}

function unwrap(result: any): any {
  if (result && typeof result === "object" && "data" in result) return result.data
  return result
}

function isTinyResponse(message: any): boolean {
  const output = Number(message?.tokens?.output ?? 0)
  const reasoning = Number(message?.tokens?.reasoning ?? 0)
  return output + reasoning <= 120
}

export default {
  id: "opencode-cache-warden",

  async setup(ctx: any) {
    const sessions = new Map<string, SessionState>()

    function state(sessionID: string): SessionState {
      const existing = sessions.get(sessionID)
      if (existing) return existing

      const created: SessionState = {
        sessionID,
        lastRealAt: 0,
        lastCacheRead: 0,
        lastCost: 0,
        warmUntil: 0,
        attempts: 0,
        warming: false,
        lastWarmAt: 0,
      }
      sessions.set(sessionID, created)
      return created
    }

    function cancel(sessionID: string) {
      const item = sessions.get(sessionID)
      if (!item?.timer) return
      clearTimeout(item.timer)
      item.timer = undefined
    }

    function eligible(item: SessionState): boolean {
      return (
        isEnabled() &&
        item.lastRealAt > 0 &&
        item.lastCacheRead >= MIN_CACHED_TOKENS &&
        Date.now() - item.lastRealAt <= IDLE_WINDOW_MS &&
        item.attempts < MAX_ATTEMPTS
      )
    }

    async function scheduleWarm(sessionID: string, delay: number) {
      const item = state(sessionID)
      cancel(sessionID)
      if (!eligible(item)) return

      item.timer = setTimeout(() => {
        item.timer = undefined

        if (!eligible(item)) return

        const idleFor = Date.now() - item.lastRealAt
        if (idleFor < IDLE_START_MS) {
          scheduleWarm(sessionID, IDLE_START_MS - idleFor)
          return
        }

        if (idleFor > IDLE_WINDOW_MS) return

        void warm(sessionID)
      }, delay)
    }

    async function warm(sessionID: string) {
      const item = state(sessionID)
      if (!eligible(item) || item.warming) return

      item.warming = true
      item.attempts += 1
      item.lastWarmAt = Date.now()

      try {
        await ctx.session.generate({
          sessionID,
          prompt: WARM_PROMPT,
        })
      } catch {
        // A failed warm request should never interrupt or fail the session.
      } finally {
        item.warming = false

        if (eligible(item)) {
          scheduleWarm(sessionID, WARM_INTERVAL_MS)
        }
      }
    }

    const controller = new AbortController()

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (!isEnabled()) continue

          const type = String(event?.type ?? "")
          const properties = event?.properties ?? {}

          if (type === "message.updated") {
            const message = properties.info ?? properties.message

            if (message?.role === "user") {
              const item = state(String(message.sessionID))
              item.lastRealAt = Date.now()
              item.attempts = 0
              cancel(message.sessionID)
              continue
            }

            if (message?.role !== "assistant") continue

            const sessionID = String(message.sessionID)
            const item = state(sessionID)

            // Ignore the transient warm response if this OpenCode version still
            // emits it. Real answers normally exceed 120 output+reasoning tokens.
            if (Date.now() - item.lastWarmAt < 90_000 && isTinyResponse(message)) {
              continue
            }

            item.lastRealAt = Date.now()
            item.providerID = message.providerID
            item.modelID = message.modelID
            item.lastCacheRead = Number(message.tokens?.cache?.read ?? 0)
            item.lastCost = Number(message.cost ?? 0)
            item.attempts = 0
            cancel(sessionID)
            continue
          }

          if (type === "session.status") {
            const status = properties.status ?? properties.state
            const statusType = String(status?.type ?? status ?? "")
            const sessionID = String(properties.sessionID ?? "")

            if (!sessionID) continue

            if (statusType === "busy" || statusType === "running") {
              state(sessionID).attempts = 0
              cancel(sessionID)
            }

            continue
          }

          if (type === "session.idle") {
            const sessionID = String(properties.sessionID ?? "")
            if (!sessionID) continue

            const item = state(sessionID)
            item.lastRealAt = item.lastRealAt || Date.now()
            item.attempts = 0

            try {
              const response = await ctx.session.get({ sessionID })
              const info = unwrap(response)

              // Skip subagents, title/summary/compaction helpers, and archived sessions.
              if (info?.parentID || info?.time?.archived) continue

              item.providerID = info?.model?.providerID ?? item.providerID
              item.modelID = info?.model?.id ?? item.modelID

              await scheduleWarm(sessionID, IDLE_START_MS)
            } catch {
              // Session no longer exists or is unavailable.
            }
          }
        }
      } catch {
        // Event stream restart failures are ignored; plugin remains loaded.
      }
    })()

    await ctx.command.transform((editor: any) => {
      editor.add({
        name: "warden",
        description: "Toggle adaptive cache warming: /warden on | off | status",
        async execute({ sessionID, prompt }: any) {
          const arg = String(prompt?.text ?? "").trim().toLowerCase()

          if (arg === "on") {
            setEnabled(true)
            await ctx.session.prompt({
              sessionID,
              text: "Adaptive cache warming enabled.",
              delivery: "queue",
            })
            return
          }

          if (arg === "off") {
            setEnabled(false)
            await ctx.session.prompt({
              sessionID,
              text: "Adaptive cache warming disabled.",
              delivery: "queue",
            })
            return
          }

          await ctx.session.prompt({
            sessionID,
            text: [
              "Adaptive cache warming status",
              `enabled: ${isEnabled()}`,
              `minimum cached tokens: ${MIN_CACHED_TOKENS}`,
              `start after idle: ${IDLE_START_MS / 60_000} minutes`,
              `window: ${IDLE_WINDOW_MS / 60_000} minutes`,
              `max pings: ${MAX_ATTEMPTS}`,
            ].join("\n"),
            delivery: "queue",
          })
        },
      })
    })

    return () => {
      controller.abort()
      for (const item of sessions.values()) {
        if (item.timer) clearTimeout(item.timer)
      }
    }
  },
}
