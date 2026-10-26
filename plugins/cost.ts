/*
 * cost.ts -- where the boring money questions live. One plugin for
 * OpenCode 2.x: slim tool descriptions, prune schemas nobody uses, a step
 * cost log you can actually read, and a cache warmer that has to prove it
 * pays for itself before it pings.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// OpenCode 2.x cost suite: slim tool descriptions, cost commands, task
// telemetry, adaptive cache warden, REA toggle. One plugin, one schema set.
//
// Guarantees:
// - never mutates the system prompt or injects session context
// - tool descriptions come from a static map, so the request prefix is stable
// - telemetry writes only numeric token/cost lines to its own state dir
// - warming is evidence-driven: enabled after observed idle cache misses,
//   disabled when sessions resume from idle with cache hits (stable), and
//   disabled when warm pings demonstrably fail to prevent misses

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

// -- constants

const IDLE_START_MS = 4 * 60_000
const WARM_INTERVAL_MS = 4 * 60_000
const IDLE_WINDOW_MS = 20 * 60_000
const MAX_ATTEMPTS = 4
// TODO: 30k floor is tuned for hyper + qwen3.8-flash pricing. Cheaper input
// means a lower floor. Re-measure per provider; do not cargo-cult it.
const MIN_CACHED_TOKENS = 30_000
const WARM_PROMPT = "Do not perform any work. Reply with exactly: OK"
const HYPERCREDIT_USD = 0.05

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

// Fixed-prefix pruning. Diagnostic and maintenance tools cost input tokens on
// every new session and every cache miss; the Review-tab workflow does not use
// them. Names are matched on the effective tool id with separators normalized,
// so both `browser.trace.start` and `browser_trace_start` styles are caught.
// Browser keep set: preview, tabs.*, navigate, screenshot, back, forward,
// reload, stop, click, fill, fill_form, press, hover, select, drag, scroll,
// wait, snapshot, find, frames, console, dialog, check, evaluate.
const REMOVE_ID_PATTERNS: RegExp[] = [
  // browser deep diagnostics: tracing, CPU/heap profiling, lighthouse,
  // network inspection, file transfer
  /^browser\.(trace|cpu|heap|network|files)\./,
  /^browser\.lighthouse$/,
  // Context Mode maintenance tools: not needed for the gather/index/search loop
  /^ctx\.(insight|doctor|upgrade|stats|purge)$/,
  /^context-mode\.ctx\.(insight|doctor|upgrade|stats|purge)$/,
]

function shouldRemove(id: string): boolean {
  const normalized = id.toLowerCase().replace(/[_:/\s]+/g, ".")
  return REMOVE_ID_PATTERNS.some((pattern) => pattern.test(normalized))
}

// -- paths

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

// Legacy kill switch kept for compatibility: cache-warden.disabled marker.
function markerPath(): string {
  return join(configDirectory(), "cache-warden.disabled")
}

function stateDirectory(): string {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(dataHome, "opencode", "cost-suite")
}

function usageLogPath(): string {
  return join(stateDirectory(), "usage.jsonl")
}

function economicsPath(): string {
  return join(stateDirectory(), "warden.json")
}

function ensureStateDir(): void {
  mkdirSync(stateDirectory(), { recursive: true })
}

// -- config edit

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

// -- warden economics

// Outcome kinds, recorded on the first real assistant step after an idle gap
// of at least IDLE_START_MS:
//   hu = hit without any warm ping  (cache outlived idle on its own)
//   hw = hit after warm pings       (warming demonstrably helped)
//   mw = miss despite warm pings    (warming failed to protect the prefix)
//   mu = miss without pings         (warming was off or not attempted)
type Outcome = { k: "hu" | "hw" | "mw" | "mu"; g: number; t: number; d?: string }

type Economics = {
  override: "auto" | "on" | "off"
  outcomes: Outcome[]
  pings: number
  lastPingAt?: number
}

function defaultEconomics(): Economics {
  return { override: "auto", outcomes: [], pings: 0 }
}

function readEconomics(): Economics {
  try {
    const raw = JSON.parse(readFileSync(economicsPath(), "utf8"))
    return {
      override: raw?.override === "on" || raw?.override === "off" ? raw.override : "auto",
      outcomes: Array.isArray(raw?.outcomes) ? raw.outcomes.slice(-20) : [],
      pings: Number(raw?.pings ?? 0),
      lastPingAt: typeof raw?.lastPingAt === "number" ? raw.lastPingAt : undefined,
    }
  } catch {
    return defaultEconomics()
  }
}

function writeEconomics(value: Economics): void {
  try {
    ensureStateDir()
    value.outcomes = value.outcomes.slice(-20)
    writeFileSync(economicsPath(), `${JSON.stringify(value, null, 2)}\n`, "utf8")
  } catch {
    // Economics persistence failure must never break the session.
  }
}

function economicsAllows(e: Economics): boolean {
  const recent = e.outcomes.slice(-6)
  const misses = recent.filter((x) => x.k === "mu" || x.k === "mw").length
  const hitWarmed = recent.filter((x) => x.k === "hw").length
  const missWarmed = recent.filter((x) => x.k === "mw").length

  // Stable sessions: cache survives idle on its own. Stop paying for pings.
  if (misses === 0 && recent.length >= 3) return false

  // Warming proven ineffective: pings did not prevent misses. Stop.
  if (missWarmed >= 2 && hitWarmed === 0) return false

  // Enable after observed misses; default on for a fresh state file.
  return misses > 0 || e.outcomes.length === 0
}

function warmWorthwhile(e: Economics): boolean {
  if (e.override === "on") return true
  if (e.override === "off") return false
  return economicsAllows(e)
}

// -- helpers

function unwrap(result: any): any {
  if (result && typeof result === "object" && "data" in result) return result.data
  return result
}

function isTinyResponse(message: any): boolean {
  const output = Number(message?.tokens?.output ?? 0)
  const reasoning = Number(message?.tokens?.reasoning ?? 0)
  return output + reasoning <= 120
}

function usd(value: number): string {
  return `$${value.toFixed(5)}`
}

function credits(value: number): string {
  return `${(value / HYPERCREDIT_USD).toFixed(3)} cr`
}

function formatStep(line: { steps: number; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; cost: number; maxCost: number }): string {
  const cachedShare = line.input + line.cacheRead > 0 ? (line.cacheRead / (line.input + line.cacheRead)) * 100 : 0
  return `steps: ${line.steps} | input: ${line.input} | cached: ${line.cacheRead} (${cachedShare.toFixed(0)}%) | output: ${line.output} | reasoning: ${line.reasoning} | cost: ${usd(line.cost)} (${credits(line.cost)}) | largest step: ${usd(line.maxCost)}`
}

type StepAggregate = {
  steps: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
  maxCost: number
}

function emptyAggregate(): StepAggregate {
  return { steps: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, maxCost: 0 }
}

function readUsageTail(lines: number): any[] {
  try {
    const text = readFileSync(usageLogPath(), "utf8")
    const raw = text.split("\n").filter(Boolean).slice(-lines)
    const parsed: any[] = []
    for (const line of raw) {
      try {
        parsed.push(JSON.parse(line))
      } catch {
        // skip malformed line
      }
    }
    return parsed
  } catch {
    return []
  }
}

function aggregateSteps(entries: any[]): StepAggregate {
  const total = emptyAggregate()
  const seen = new Set<string>()
  for (const entry of entries) {
    if (entry?.t !== "step") continue
    // Multiple plugin instances (one per desktop location) append the same
    // durable step. The k field is the aggregate:seq dedup key.
    const key = String(entry.k ?? "")
    if (key) {
      if (seen.has(key)) continue
      seen.add(key)
    }
    total.steps += 1
    total.input += Number(entry.i ?? 0)
    total.output += Number(entry.o ?? 0)
    total.reasoning += Number(entry.r ?? 0)
    total.cacheRead += Number(entry.cr ?? 0)
    total.cacheWrite += Number(entry.cw ?? 0)
    total.cost += Number(entry.c ?? 0)
    total.maxCost = Math.max(total.maxCost, Number(entry.c ?? 0))
  }
  return total
}

export default {
  id: "cost",
  async setup(ctx: any) {
    // -- slim tool descriptions

    await ctx.tool.transform((editor: any) => {
      const report = { at: Date.now(), removed: [], errors: [], registered: editor.list().map((tool: any) => String(tool?.id ?? "")) }

      for (const tool of editor.list()) {
        const id = String(tool?.id ?? "")
        if (!shouldRemove(id)) continue
        try {
          editor.remove(id)
          report.removed.push(id)
        } catch (error) {
          report.errors.push(`${id}: ${String(error?.message ?? error)}`)
        }
      }

      try {
        ensureStateDir()
        writeFileSync(join(stateDirectory(), "prune-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8")
      } catch {
        // Report is diagnostics only.
      }
    })

    await ctx.tool.transform((editor: any) => {
      for (const [toolID, description] of Object.entries(SLIM_DESCRIPTIONS)) {
        editor.update(toolID, (tool: any) => {
          tool.description = description
        })
      }
    })

    // -- session runtime state

    type SessionState = {
      sessionID: string
      providerID?: string
      modelID?: string
      lastRealAt: number
      lastCacheRead: number
      pingsSinceReal: number
      warmUntil: number
      attempts: number
      timer?: ReturnType<typeof setTimeout>
      warming: boolean
      lastWarmAt: number
      pending: Map<string, any>
      flushed: Set<string>
      lastTaskAt?: number
    }

    const sessions = new Map<string, SessionState>()

    function state(sessionID: string): SessionState {
      const existing = sessions.get(sessionID)
      if (existing) return existing
      const created: SessionState = {
        sessionID,
        lastRealAt: 0,
        lastCacheRead: 0,
        pingsSinceReal: 0,
        warmUntil: 0,
        attempts: 0,
        warming: false,
        lastWarmAt: 0,
        pending: new Map(),
        flushed: new Set(),
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

    function legacyDisabled(): boolean {
      return existsSync(markerPath())
    }

    function setLegacyDisabled(disabled: boolean): string {
      const path = markerPath()
      mkdirSync(dirname(path), { recursive: true })
      if (disabled) {
        if (!existsSync(path)) writeFileSync(path, "disabled by /warden off\n", "utf8")
      } else if (existsSync(path)) {
        unlinkSync(path)
      }
      return path
    }

    function warmingAllowed(): boolean {
      return !legacyDisabled() && warmWorthwhile(readEconomics())
    }

    function eligible(item: SessionState): boolean {
      return (
        !legacyDisabled() &&
        item.lastRealAt > 0 &&
        item.lastCacheRead >= MIN_CACHED_TOKENS &&
        Date.now() - item.lastRealAt <= IDLE_WINDOW_MS &&
        item.attempts < MAX_ATTEMPTS
      )
    }

    function appendUsage(entry: any): void {
      try {
        ensureStateDir()
        appendFileSync(usageLogPath(), `${JSON.stringify(entry)}\n`, "utf8")
      } catch {
        // Telemetry must never break the session.
      }
    }

    // Event-stream diagnostics: records event types only, never content.
    // Capped so it cannot grow without bound. Used to verify the subscription
    // works on a given OpenCode build; delete debug file to restart capture.
    let debugLines = 0
    function appendEventDebug(type: string, sessionID: string): void {
      try {
        const path = join(stateDirectory(), "events-debug.jsonl")
        if (debugLines >= 500 || (existsSync(path) && readFileSync(path, "utf8").split("\n").filter(Boolean).length >= 500)) return
        debugLines += 1
        ensureStateDir()
        appendFileSync(path, `${JSON.stringify({ t: type, s: sessionID ? sessionID.slice(0, 8) : "", ts: Date.now() })}\n`, "utf8")
      } catch {
        // Diagnostics must never break the session.
      }
    }

    // Shape diagnostics: keys + primitive numbers only. Never logs text
    // content. Records the first few events per type so handlers can be
    // written against the real payload of a build. Cap 40 lines.
    const shapeSeen = new Map<string, number>()
    let shapeLines = 0
    function summarize(value: any, depth: number): any {
      if (value === null || typeof value === "number" || typeof value === "boolean") return value
      if (typeof value === "string") return value.length
      if (Array.isArray(value)) return { len: value.length, first: value.length ? summarize(value[0], depth + 1) : undefined }
      if (typeof value === "object" && depth < 3) {
        const out: Record<string, any> = {}
        for (const key of Object.keys(value).slice(0, 24)) out[key] = summarize(value[key], depth + 1)
        return out
      }
      return typeof value
    }

    function appendEventShape(type: string, properties: any): void {
      try {
        const seen = shapeSeen.get(type) ?? 0
        if (seen >= 3 || shapeLines >= 120) return
        shapeSeen.set(type, seen + 1)
        shapeLines += 1
        ensureStateDir()
        appendFileSync(join(stateDirectory(), "events-shape.jsonl"), `${JSON.stringify({ t: type, p: summarize(properties, 0) })}\n`, "utf8")
      } catch {
        // Diagnostics only.
      }
    }

    // -- warming

    async function scheduleWarm(sessionID: string, delay: number) {
      const item = state(sessionID)
      cancel(sessionID)
      if (!eligible(item) || !warmingAllowed()) return

      item.timer = setTimeout(() => {
        item.timer = undefined
        if (!eligible(item) || !warmingAllowed()) return

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
      if (!eligible(item) || item.warming || !warmingAllowed()) return

      item.warming = true
      item.attempts += 1
      item.lastWarmAt = Date.now()

      const econ = readEconomics()

      // The desktop runs one plugin instance per location and they all see the
      // same event bus. Yes, all of them. Debounce through the shared
      // warden.json so one warm ping costs once, not three times.
      if (econ.lastPingAt && Date.now() - econ.lastPingAt < 90_000) {
        item.warming = false
        if (eligible(item)) scheduleWarm(sessionID, WARM_INTERVAL_MS)
        return
      }

      econ.pings += 1
      econ.lastPingAt = Date.now()
      writeEconomics(econ)
      appendUsage({ t: "warm", s: sessionID, n: item.attempts, ts: Date.now() })

      try {
        await ctx.session.generate({ sessionID, prompt: WARM_PROMPT })
      } catch {
        // A failed warm request should never interrupt the session.
      } finally {
        item.warming = false
        if (eligible(item)) scheduleWarm(sessionID, WARM_INTERVAL_MS)
      }
    }

    // -- idle-resume classification

    function recordResumeOutcome(item: SessionState, cacheRead: number, durableID: string) {
      if (!item.lastRealAt) return // first observed step, not a resume

      const gap = Date.now() - item.lastRealAt
      if (gap < IDLE_START_MS) return // normal in-task step, not an idle resume

      let kind: Outcome["k"]
      if (cacheRead >= MIN_CACHED_TOKENS) {
        kind = item.pingsSinceReal > 0 ? "hw" : "hu"
      } else {
        kind = item.pingsSinceReal > 0 ? "mw" : "mu"
      }
      item.pingsSinceReal = 0

      const econ = readEconomics()
      // Cross-instance dedup: the same durable step can reach several
      // plugin instances. Never record the same step twice.
      if (durableID && econ.outcomes.some((x) => x.d === durableID)) return
      econ.outcomes.push({ k: kind, g: Math.round(gap / 60_000), t: Date.now(), d: durableID || undefined })
      writeEconomics(econ)
    }

    // -- step telemetry

    function flushAssistantStep(item: SessionState, snap: any) {
      const messageID = String(snap.id ?? "")
      if (messageID && item.flushed.has(messageID)) return
      if (messageID) item.flushed.add(messageID)
      if (item.flushed.size > 1000) item.flushed.clear()
      item.pending.delete(messageID)

      const cacheRead = Number(snap.cacheRead ?? 0)

      // Ignore transient warm responses if this version still emits them.
      if (Date.now() - item.lastWarmAt < 90_000 && snap.output + snap.reasoning <= 120) {
        return
      }

      recordResumeOutcome(item, cacheRead, messageID)

      item.lastRealAt = Date.now()
      item.providerID = snap.providerID ?? item.providerID
      item.modelID = snap.modelID ?? item.modelID
      item.lastCacheRead = cacheRead
      item.attempts = 0
      cancel(item.sessionID)

      appendUsage({
        t: "step",
        k: snap.id || "",
        s: item.sessionID,
        p: snap.providerID ?? item.providerID ?? "",
        m: snap.modelID ?? item.modelID ?? "",
        i: snap.input,
        o: snap.output,
        r: snap.reasoning,
        cr: cacheRead,
        cw: snap.cacheWrite,
        c: snap.cost,
        ts: Date.now(),
      })
    }

    function snapshot(message: any): any {
      const tokens = message?.tokens ?? {}
      const cache = tokens.cache ?? {}
      return {
        id: String(message?.id ?? ""),
        sessionID: String(message?.sessionID ?? ""),
        providerID: message?.providerID,
        modelID: message?.modelID,
        input: Number(tokens.input ?? 0),
        output: Number(tokens.output ?? 0),
        reasoning: Number(tokens.reasoning ?? 0),
        cacheRead: Number(cache.read ?? 0),
        cacheWrite: Number(cache.write ?? 0),
        cost: Number(message?.cost ?? 0),
      }
    }

    // -- v2 event mapping

    function getPath(obj: any, path: string[]): any {
      let cur = obj
      for (const key of path) {
        if (cur === null || typeof cur !== "object") return undefined
        cur = cur[key]
      }
      return cur
    }

    // v2 session events carry the payload under event.data
    function eventValue(event: any, ...keys: string[]): any {
      if (event?.data !== null && typeof event?.data === "object") {
        let cur = event.data
        for (const key of keys) {
          if (cur === null || typeof cur !== "object") return undefined
          cur = cur[key]
        }
        return cur
      }
      return undefined
    }

    function eventNumber(event: any, ...keyPaths: string[][]): number | undefined {
      for (const keys of keyPaths) {
        const v = eventValue(event, ...keys)
        if (typeof v === "number") return v
      }
      return undefined
    }

    function eventString(event: any, ...keyPaths: string[][]): string | undefined {
      for (const keys of keyPaths) {
        const v = eventValue(event, ...keys)
        if (typeof v === "string") return v
      }
      return undefined
    }

    function firstString(obj: any, paths: string[][]): string | undefined {
      for (const p of paths) {
        const v = getPath(obj, p)
        if (typeof v === "string") return v
      }
      return undefined
    }

    const SESSION_ID_PATHS = [["sessionID"], ["session", "id"], ["info", "sessionID"], ["value", "sessionID"]]

    function handleV2Step(event: any): boolean {
      const sessionID = eventString(event, ["sessionID"])
      const cacheRead = eventNumber(event, ["tokens", "cache", "read"], ["tokens", "cacheRead"])
      if (!sessionID || cacheRead === undefined) return false

      const durable = event?.durable
      const id = durable?.seq !== undefined ? `${durable.aggregateID ?? ""}:${durable.seq}` : ""

      const item = state(sessionID)
      flushAssistantStep(item, {
        id,
        sessionID,
        providerID: eventString(event, ["model", "providerID"]) ?? eventString(event, ["providerID"]),
        modelID: eventString(event, ["model", "id"]) ?? eventString(event, ["modelID"]),
        input: eventNumber(event, ["tokens", "input"]) ?? 0,
        output: eventNumber(event, ["tokens", "output"]) ?? 0,
        reasoning: eventNumber(event, ["tokens", "reasoning"]) ?? 0,
        cacheRead,
        cacheWrite: eventNumber(event, ["tokens", "cache", "write"]) ?? 0,
        cost: eventNumber(event, ["cost"]) ?? 0,
      })

      // Idle-based warming: arm the timer after every real step. It only
      // fires when the session stays quiet for IDLE_START_MS.
      void scheduleWarm(sessionID, IDLE_START_MS)
      return true
    }

    function handleV2User(event: any) {
      const sessionID = eventString(event, ["sessionID"]) ?? firstString(event?.properties ?? {}, SESSION_ID_PATHS)
      if (!sessionID) return
      const item = state(sessionID)
      const now = Date.now()
      item.lastRealAt = now
      item.attempts = 0
      cancel(sessionID)
      // Deduplicate rapid prompt lifecycle events into one task marker.
      if (now - (item.lastTaskAt ?? 0) > 30_000) {
        item.lastTaskAt = now
        appendUsage({ t: "task", s: sessionID, ts: now })
      }
    }

    async function handleV2Idle(event: any) {
      const sessionID = eventString(event, ["sessionID"])
      if (!sessionID) return

      const item = state(sessionID)
      for (const snap of [...item.pending.values()]) {
        flushAssistantStep(item, snap)
      }
      item.lastRealAt = item.lastRealAt || Date.now()
      item.attempts = 0

      try {
        const response = await ctx.session.get({ sessionID })
        const info = unwrap(response)
        if (!info?.parentID && !info?.time?.archived) {
          item.providerID = info?.model?.providerID ?? item.providerID
          item.modelID = info?.model?.id ?? item.modelID
          await scheduleWarm(sessionID, IDLE_START_MS)
        }
      } catch {
        // Session no longer exists or is unavailable.
      }
    }

    // -- events

    const controller = new AbortController()

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const type = String(event?.type ?? "")
          const properties = event?.properties ?? {}
          const eventSession = String(eventValue(event, "sessionID") ?? properties.sessionID ?? "")
          appendEventDebug(type, eventSession)
          if (!/delta/.test(type)) appendEventShape(type, event)

          // OpenCode 2.x event names (verified against desktop build payloads).
          if (type === "session.step.started") {
            const sessionID = eventSession
            if (sessionID) {
              const item = state(sessionID)
              const modelID = eventString(event, ["model", "id"])
              const variant = eventString(event, ["model", "variant"])
              item.providerID = eventString(event, ["model", "providerID"]) ?? item.providerID
              item.modelID = modelID ? (variant ? `${modelID}#${variant}` : modelID) : item.modelID
            }
            continue
          }
          if (type === "session.step.ended") {
            handleV2Step(event)
            continue
          }
          if (type === "session.usage.updated") {
            continue // cumulative totals; step lines already capture per-step data
          }
          if (type === "session.idle" || type === "session.status.idle") {
            await handleV2Idle(event)
            continue
          }
          if (type === "session.status") {
            const statusType = String(getPath(properties, ["status", "type"]) ?? getPath(properties, ["state", "type"]) ?? eventValue(event, "status", "type") ?? "")
            const sessionID = eventSession
            if (sessionID && (statusType === "busy" || statusType === "running")) {
              state(sessionID).attempts = 0
              cancel(sessionID)
            }
            continue
          }
          if (/^session\.(prompt|message|input)\./i.test(type) && !/delta|progress/.test(type)) {
            handleV2User(event)
            continue
          }

          if (type === "message.updated") {
            const message = properties.info ?? properties.message

            if (message?.role === "user") {
              const sessionID = String(message.sessionID)
              const item = state(sessionID)
              const now = Date.now()
              item.lastRealAt = now
              item.attempts = 0
              cancel(sessionID)
              if (now - (item.lastTaskAt ?? 0) > 30_000) {
                item.lastTaskAt = now
                appendUsage({ t: "task", s: sessionID, ts: now })
              }
              continue
            }

            if (message?.role !== "assistant") continue

            const sessionID = String(message.sessionID)
            const item = state(sessionID)
            const snap = snapshot(message)
            if (snap.id) item.pending.set(snap.id, snap)

            // Log once per completed assistant message; streaming updates only
            // refresh the latest snapshot.
            if (message?.time?.completed) {
              flushAssistantStep(item, snap)
            }
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

            // Fallback flush for completed steps whose update lacked a
            // completion marker. The flushed set keeps this idempotent.
            for (const snap of [...item.pending.values()]) {
              flushAssistantStep(item, snap)
            }

            item.lastRealAt = item.lastRealAt || Date.now()
            item.attempts = 0

            try {
              const response = await ctx.session.get({ sessionID })
              const info = unwrap(response)

              // Skip subagents and archived sessions for warming.
              if (!info?.parentID && !info?.time?.archived) {
                item.providerID = info?.model?.providerID ?? item.providerID
                item.modelID = info?.model?.id ?? item.modelID
                await scheduleWarm(sessionID, IDLE_START_MS)
              }
            } catch {
              // Session no longer exists or is unavailable.
            }
          }
        }
      } catch {
        // Event stream failures are ignored; plugin remains loaded.
      }
    })()

    // -- commands

    async function reply(sessionID: string, text: string) {
      await ctx.session.prompt({ sessionID, text, delivery: "queue" })
    }

    async function setNativeWarming(sessionID: string, enabled: boolean) {
      const config = readConfig()
      config.warming = enabled ? { interval: "4 minutes", duration: "20 minutes" } : false
      const path = writeConfig(config)
      await reply(
        sessionID,
        enabled
          ? `Native warming enabled: first request after 4 idle minutes, window lasts 20 minutes. Config: ${path}. Adaptive warden is preferred; native warming overlaps it.`
          : `Native warming disabled. Adaptive warden still applies. Config: ${path}.`
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

    async function setRea(sessionID: string, enabled: boolean) {
      try {
        await ctx.mcp.transform((editor: any) => {
          editor.update("rea", (server: any) => {
            server.disabled = !enabled
          })
        })
        await ctx.mcp.reload()
        await reply(
          sessionID,
          enabled
            ? "REA enabled. Use reverse-engineering tools when needed. Expect one cache-prefix miss as tool schemas change."
            : "REA disabled. Tool schemas removed from future context."
        )
      } catch {
        await reply(sessionID, "REA MCP entry not found in config.")
      }
    }

    async function costStatus(sessionID: string) {
      const config = readConfig()
      const servers = await ctx.mcp.list()
      const warming = config.warming === undefined ? false : config.warming
      const econ = readEconomics()
      const recent = econ.outcomes.slice(-6).map((x) => x.k).join(",") || "none"

      await reply(
        sessionID,
        [
          "Cost suite status",
          `default model: ${config.model ?? "session-selected"}`,
          `native warming: ${JSON.stringify(warming)}`,
          `adaptive warden: ${legacyDisabled() ? "disabled (marker)" : econ.override} | currently ${warmingAllowed() ? "ARMED" : "held back"}`,
          `warden evidence (last 6 idle resumes): ${recent} | lifetime pings: ${econ.pings}`,
          `minimum cached tokens: ${MIN_CACHED_TOKENS} | ping 4m, max ${MAX_ATTEMPTS}, window ${IDLE_WINDOW_MS / 60_000}m`,
          `usage log: ${usageLogPath()}`,
          `MCP state: ${JSON.stringify(servers)}`,
          "Commands: /cost status|task|report|warm on|off|mcp <server> on|off|compact | /warden status|on|off|reset | /rea on|off",
        ].join("\n")
      )
    }

    async function wardenStatus(sessionID: string) {
      const econ = readEconomics()
      const recent = econ.outcomes.slice(-6).map((x) => `${x.k}(${x.g}m)`).join(", ") || "none yet"
      await reply(
        sessionID,
        [
          "Adaptive cache warden",
          `marker file off: ${legacyDisabled()}`,
          `override: ${econ.override}`,
          `arming: ${warmingAllowed() ? "ARMED (will warm eligible sessions)" : "held back by evidence"}`,
          `evidence rule: enable after idle cache misses; disable when 3+ resumes hit cache without misses; disable after 2 warmed misses`,
          `last resumes: ${recent}`,
          `lifetime warm pings: ${econ.pings}`,
          `minimum cached tokens: ${MIN_CACHED_TOKENS}`,
          `start after idle: ${IDLE_START_MS / 60_000}m | interval: ${WARM_INTERVAL_MS / 60_000}m | max pings: ${MAX_ATTEMPTS} | window: ${IDLE_WINDOW_MS / 60_000}m`,
        ].join("\n")
      )
    }

    async function costTask(sessionID: string) {
      const entries = readUsageTail(4000).filter((x) => x?.s === sessionID)
      if (!entries.length) {
        await reply(sessionID, "No telemetry rows for this session yet. Telemetry records steps after this plugin loads; older history is not retroactive.")
        return
      }

      // Task boundaries are user-message markers. Current task = after last marker.
      const lastMarker = entries.filter((x) => x?.t === "task").pop()
      const current = entries.filter((x) => x?.t === "step" && (!lastMarker || (x.ts ?? 0) >= (lastMarker.ts ?? 0)))
      const whole = aggregateSteps(entries)
      const task = aggregateSteps(current)
      const pings = entries.filter((x) => x?.t === "warm").length

      const stepEntries = entries.filter((x) => x?.t === "step")
      const hitSteps = stepEntries.filter((x) => Number(x.cr ?? 0) > 0).length
      const hitRate = stepEntries.length ? ((hitSteps / stepEntries.length) * 100).toFixed(0) : "0"

      await reply(
        sessionID,
        [
          "Session usage (/cost task)",
          formatStep(task) + " <- current task since last user prompt",
          formatStep(whole) + " <- whole session",
          `warm pings this session: ${pings}`,
          `cache hit rate (session steps): ${hitRate}%`,
        ].join("\n")
      )
    }

    async function costReport(sessionID: string) {
      const entries = readUsageTail(4000)
      const bySession = new Map<string, StepAggregate>()
      const linesFor = new Map<string, any[]>()
      let warmPings = 0
      for (const entry of entries) {
        if (entry?.t === "warm") {
          warmPings += 1
          continue
        }
        if (entry?.t !== "step") continue
        const key = String(entry.s ?? "")
        if (!linesFor.has(key)) linesFor.set(key, [])
        linesFor.get(key)!.push(entry)
      }
      for (const [key, lines] of linesFor) {
        bySession.set(key, aggregateSteps(lines))
      }

      const ranked = [...bySession.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 8)
      const lines = [`Cost report (last ${entries.length} telemetry lines, warm pings: ${warmPings})`]
      for (const [id, agg] of ranked) {
        lines.push(`${id.slice(0, 12)}… ${formatStep(agg)}`)
      }
      if (!ranked.length) lines.push("No steps recorded yet.")
      await reply(sessionID, lines.join("\n"))
    }

    await ctx.command.transform((editor: any) => {
      editor.add({
        name: "cost",
        description: "Cost suite: /cost status | task | report | warm on|off | mcp <server> on|off | compact",
        async execute({ sessionID, prompt }: any) {
          const args = commandArgs(prompt?.text)
          const command = args[0]?.toLowerCase()

          if (!command || command === "status") {
            await costStatus(sessionID)
            return
          }
          if (command === "task") {
            await costTask(sessionID)
            return
          }
          if (command === "report") {
            await costReport(sessionID)
            return
          }
          if (command === "warm") {
            const enabled = truthy(args[1] ?? "")
            if (enabled === null) {
              await reply(sessionID, "Usage: /cost warm on | /cost warm off")
              return
            }
            await setNativeWarming(sessionID, enabled)
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

          await reply(sessionID, "Cost suite usage:\n/cost status\n/cost task\n/cost report\n/cost warm on|off\n/cost mcp <server> on|off\n/cost compact")
        },
      })

      editor.add({
        name: "warden",
        description: "Adaptive cache warming: /warden status | on | off | reset",
        async execute({ sessionID, prompt }: any) {
          const arg = String(prompt?.text ?? "").trim().toLowerCase()

          if (arg === "on" || arg === "off") {
            const econ = readEconomics()
            econ.override = arg === "on" ? "on" : "off"
            writeEconomics(econ)
            setLegacyDisabled(false) // marker removed; override now controls arming
            await reply(sessionID, arg === "on" ? "Warden forced on (manual override)." : "Warden forced off (manual override).")
            return
          }

          if (arg === "reset") {
            const fresh = defaultEconomics()
            writeEconomics(fresh)
            await reply(sessionID, "Warden evidence and override reset to auto.")
            return
          }

          await wardenStatus(sessionID)
        },
      })

      editor.add({
        name: "rea",
        description: "Enable or disable REA MCP: /rea on | /rea off",
        async execute({ sessionID, prompt }: any) {
          const arg = String(prompt?.text ?? "").trim().toLowerCase()
          if (arg === "on" || arg === "enable") {
            await setRea(sessionID, true)
            return
          }
          if (arg === "off" || arg === "disable") {
            await setRea(sessionID, false)
            return
          }
          await reply(sessionID, "Usage: `/rea on` enables REA. `/rea off` disables REA.")
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

export { economicsAllows, warmWorthwhile, defaultEconomics, SLIM_DESCRIPTIONS }

export { shouldRemove, REMOVE_ID_PATTERNS }
