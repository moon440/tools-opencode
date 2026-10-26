// Static checks: load the plugin, verify prune patterns and the slim map,
// run the warming economics rules, and grep shipped files for anything that
// smells like a secret or a personal path. Run: node tests/verify.mjs
//
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const failures = []

function check(name, condition) {
  if (condition) {
    console.log(`[OK]   ${name}`)
  } else {
    console.log(`[FAIL] ${name}`)
    failures.push(name)
  }
}

const suite = await import(pathToFileURL(join(root, "plugins", "cost.ts")).href)
check("cost suite plugin loads", suite.default?.id === "cost")
check("cost suite exports setup", typeof suite.default?.setup === "function")

const slimKeys = Object.keys(suite.SLIM_DESCRIPTIONS)
for (const key of ["read", "glob", "grep", "edit", "write", "shell", "subagent"]) {
  check(`slim map keeps "${key}"`, slimKeys.includes(key))
}

// Pruning: exactly the diagnostic families drop; everything else survives.
const removeIds = [
  "browser.trace.start", "browser.trace.stop", "browser.trace.analyze",
  "browser.cpu.start", "browser.cpu.stop", "browser.cpu.analyze",
  "browser.heap.snapshot", "browser.heap.query", "browser.heap.summary",
  "browser.heap.compare", "browser.heap.object",
  "browser.network.list", "browser.network.get",
  "browser.files.upload", "browser.files.drop", "browser.files.get", "browser.files.list",
  "browser.lighthouse",
  "context-mode.ctx_insight", "context-mode.ctx_doctor", "context-mode.ctx_upgrade",
  "context-mode.ctx_stats", "context-mode.ctx_purge",
  "ctx_stats", "browser_trace_start", "browser_lighthouse",
]
const keepIds = [
  "browser.preview", "browser.tabs.open", "browser.tabs.list", "browser.navigate",
  "browser.screenshot", "browser.stop", "browser.forward", "browser.evaluate",
  "context-mode.ctx_execute", "context-mode.ctx_execute_file", "context-mode.ctx_fetch_and_index",
  "context-mode.ctx_index", "context-mode.ctx_search", "context-mode.ctx_batch_execute",
  "read", "websearch", "lsp", "todo", "ctx_index", "ctx_search",
]
for (const id of removeIds) check(`prunes ${id}`, suite.shouldRemove(id) === true)
for (const id of keepIds) check(`keeps ${id}`, suite.shouldRemove(id) === false)
check("prune removes 26 schema id variants", removeIds.filter((id) => suite.shouldRemove(id)).length === 26)

const o = (k, g = 5) => ({ k, g, t: 0 })
const econ = (...outcomes) => ({ override: "auto", outcomes, pings: 0 })

// Fresh state: default armed.
check("fresh state arms warming", suite.economicsAllows(econ()) === true)
// Stable sessions (3+ resumes, all cache hits) -> stop paying for pings.
check("stable hits disarm", suite.economicsAllows(econ(o("hu"), o("hu"), o("hu"))) === false)
// Observed miss -> arm.
check("miss re-arms", suite.economicsAllows(econ(o("hu"), o("hu"), o("hu"), o("mu"))) === true)
// Pings proven ineffective (2 warmed misses, no warmed hit) -> disarm.
check("ineffective warming disarms", suite.economicsAllows(econ(o("mu"), o("mw"), o("mw"))) === false)
// Warming working (warmed hits) -> stay armed.
check("warmed hits keep armed", suite.economicsAllows(econ(o("mu"), o("hw"), o("hw"), o("mu"))) === true)

check("manual off overrides evidence", suite.warmWorthwhile({ override: "off", outcomes: [o("mu")], pings: 0 }) === false)
check("manual on overrides evidence", suite.warmWorthwhile({ override: "on", outcomes: [o("hu"), o("hu"), o("hu")], pings: 0 }) === true)

// Shipped files must not contain personal paths or secret markers.
const scanFiles = []
for (const dir of ["plugins", "docs", "examples"]) {
  const abs = join(root, dir)
  if (!readdirSync) break
  for (const f of readdirSync(abs)) scanFiles.push(join(abs, f))
}
scanFiles.push(join(root, "README.md"))
const banned = [/C:\\Users\\[A-Za-z0-9_.-]+/i, /\/home\/[a-z]+\/[a-z]/i, /sk-[A-Za-z0-9]{16,}/, /Bearer [A-Za-z0-9._-]{20,}/, /ses_[A-Za-z0-9]+/]
for (const file of scanFiles) {
  const text = readFileSync(file, "utf8")
  for (const pattern of banned) {
    check(`${file.replace(root, "")} clean of ${pattern.source.slice(0, 18)}`, !pattern.test(text))
  }
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log("\nall checks passed")
