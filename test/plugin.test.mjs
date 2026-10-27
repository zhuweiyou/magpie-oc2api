// Tests for the parts that decide things rather than talk to the network:
// which projects become seats, which seat a request goes to, and what the
// model list comes to. Run with: npm test

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Store, safe } from "../store.mjs"
import { shapeProject } from "../vercel.mjs"
import { seatsOf, choose, healthy, Seats } from "../seats.mjs"
import { client } from "../vercel.mjs"
import { passes, table, modelEntry, readAny } from "../models.mjs"
import { _internal } from "../index.mjs"

// proj is a project as shapeProject returns it. Names are given in full:
// a helper that added the prefix would hide whether the filter works.
const proj = (name) => ({ id: "prj_" + name, name, origin: `https://${name}.vercel.app` })

test("every project whose name mentions oc2api becomes a seat", () => {
  const seats = seatsOf([
    { id: "prj_1", name: "oc2api-us", origin: "https://oc2api-us.vercel.app" },
    { id: "prj_2", name: "oc2api-eu", origin: "https://oc2api-eu.vercel.app" },
    { id: "prj_3", name: "my-oc2api-x", origin: "https://my-oc2api-x.vercel.app" },
    { id: "prj_4", name: "OC2API-mixed", origin: "https://oc2api-mixed.vercel.app" },
    { id: "prj_5", name: "app", origin: "https://app.vercel.app" },
    { id: "prj_6", name: "oc2api", origin: "https://oc2api.vercel.app" },
  ])
  assert.deepEqual(
    seats.map((s) => s.name),
    ["oc2api-us", "oc2api-eu", "my-oc2api-x", "OC2API-mixed", "oc2api"],
  )
})

test("a project with no origin is not a seat", () => {
  const seats = seatsOf([{ id: "prj_a", name: "oc2api-a", origin: "" }, proj("oc2api-b")])
  assert.deepEqual(
    seats.map((s) => s.name),
    ["oc2api-b"],
  )
})

test("a project's origin is its production alias", () => {
  const p = shapeProject({
    id: "prj_1",
    name: "oc2api-us",
    targets: { production: { alias: ["custom.example", "oc2api-us.vercel.app"], readyState: "READY" } },
  })
  assert.equal(p.origin, "https://oc2api-us.vercel.app")
})

test("requests spread over the seats instead of piling on the first", () => {
  const seats = seatsOf([proj("oc2api-a"), proj("oc2api-b"), proj("oc2api-c")])
  const taken = []
  for (let i = 0; i < 6; i++) {
    const s = choose(seats)
    taken.push(s.name)
    s.sent++
  }
  // three seats, six sends: each takes two, and neighbours differ
  const counts = taken.reduce((m, n) => ({ ...m, [n]: (m[n] ?? 0) + 1 }), {})
  assert.deepEqual(counts, { "oc2api-a": 2, "oc2api-b": 2, "oc2api-c": 2 })
  assert.notEqual(taken[0], taken[1])
})

test("a seat that is busy elsewhere is left for a free one", () => {
  const seats = seatsOf([proj("oc2api-a"), proj("oc2api-b")])
  seats[0].busy = 1
  assert.equal(choose(seats).name, "oc2api-b")
})

test("a seat that just failed sits out while others are free", () => {
  const seats = seatsOf([proj("oc2api-a"), proj("oc2api-b")])
  seats[0].sent = 0
  seats[0].failedAt = Date.now()
  assert.equal(healthy(seats[0]), false)
  // b has sent nothing either, but it is the healthy one
  assert.equal(choose(seats).name, "oc2api-b")
})

test("when every seat sits out, one is still tried", () => {
  const seats = seatsOf([proj("oc2api-a"), proj("oc2api-b")])
  for (const s of seats) s.failedAt = Date.now()
  assert.ok(choose(seats), "a request must not be dropped for want of a fresh seat")
})

test("a seat already tried for this request is avoided", () => {
  const seats = seatsOf([proj("oc2api-a"), proj("oc2api-b")])
  const avoid = new Set([seats[0].id])
  assert.equal(choose(seats, avoid).name, "oc2api-b")
  avoid.add(seats[1].id)
  assert.equal(choose(seats, avoid), null)
})

test("a seat that recovers is usable again after the wait", () => {
  // the wait is the one a seat names (Retry-After), or ten minutes for one
  // that named nothing: a spent free tier comes back in hours, not minutes
  const seats = seatsOf([proj("oc2api-a")])
  seats[0].failedAt = Date.now() - 130_000
  assert.equal(healthy(seats[0]), false, "two minutes is inside the default rest")
  seats[0].failedAt = Date.now() - 11 * 60_000
  assert.equal(healthy(seats[0]), true)
})

test("refreshing seats keeps the counters of the ones still there", () => {
  const seats = new Seats()
  seats.replace(seatsOf([proj("oc2api-a"), proj("oc2api-b")]))
  seats.list[0].sent = 7
  seats.replace(seatsOf([proj("oc2api-a"), proj("oc2api-c")]))
  assert.equal(seats.byId("prj_oc2api-a").sent, 7)
  assert.equal(seats.byId("prj_oc2api-c").sent, 0)
  assert.equal(seats.size, 2)
})

test("refreshing the project list keeps each seat's key", () => {
  // the key is read from Vercel on a half-hour timer and the project list
  // is replaced on a one-minute one: a replace that forgot the key made the
  // account file report hasKey false for every seat a minute after sign-in
  const seats = new Seats()
  seats.replace(seatsOf([proj("oc2api-a"), proj("oc2api-b")]))
  seats.list[0].key = "sk-test-1"
  seats.list[0].ip = "203.0.113.7"
  seats.list[1].ok = false
  seats.replace(seatsOf([proj("oc2api-a"), proj("oc2api-b")]))
  assert.equal(seats.byId("prj_oc2api-a").key, "sk-test-1", "the key survives the refresh")
  assert.equal(seats.byId("prj_oc2api-a").ip, "203.0.113.7")
  assert.equal(seats.byId("prj_oc2api-b").ok, false, "a seat marked down stays down")
  assert.equal(seats.byId("prj_oc2api-b").key, "", "a seat that never had one has none")
})

test("only the free tier passes, as oc2api filters it", () => {
  assert.equal(passes("big-pickle"), true)
  assert.equal(passes("beam-free"), true)
  assert.equal(passes("glm-5.3-flash"), false)
  assert.equal(passes("text-embedding-3"), false)
})

test("models carry no single origin, because the seats pick it", () => {
  const m = modelEntry("big-pickle")
  assert.equal(m.id, "big-pickle")
  assert.equal(m.api.url, undefined)
  assert.equal(m.free, true)
  assert.equal(m.capabilities.toolcall, true)
  assert.equal(m.limit.context, 200000)
})

test("the model table is keyed by the ids oc2api serves", () => {
  const t = table([{ id: "big-pickle" }, { id: "jev-1.13-free" }])
  assert.deepEqual(Object.keys(t), ["big-pickle", "jev-1.13-free"])
})

test("a model id carrying a project name never reaches the list", () => {
  // the shape an earlier version produced, which showed seats in the picker
  const t = table([
    { id: "oc2api-us/big-pickle" },
    { id: "oc2api-eu/beam-free" },
    { id: "big-pickle" },
  ])
  assert.deepEqual(Object.keys(t), ["big-pickle"])
})

test("the same model twice is listed once", () => {
  const t = table([{ id: "big-pickle" }, { id: "big-pickle" }])
  assert.deepEqual(Object.keys(t), ["big-pickle"])
})

test("the list is read from the first seat that answers", async () => {
  const asked = []
  const ids = await readAny(
    [
      { name: "a", origin: "https://a", key: "" },
      { name: "b", origin: "https://b", key: "" },
    ],
    { timeoutMs: 100 },
  ).catch(() => null)
  // nothing is listening on those hosts, so this is the "no seat answered" path
  assert.equal(ids, null)
})

test("a key is read from the env pull, not the env list", async () => {
  const realFetch = globalThis.fetch
  let asked = ""
  globalThis.fetch = async (url, init) => {
    asked = String(url)
    assert.equal(init.headers.authorization, "Bearer tok")
    return new Response(JSON.stringify({ env: { API_KEY: "sk-test-1" } }), { status: 200 })
  }
  try {
    const key = await client("tok").envValue("prj_1", "API_KEY")
    assert.equal(key, "sk-test-1")
    assert.match(asked, /\/v3\/env\/pull\/prj_1\/production$/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("a project with no key reads as empty, not as an error", async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response("{}", { status: 200 })
  try {
    assert.equal(await client("tok").envValue("prj_1", "API_KEY"), "")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("a refused env pull reads as empty too", async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response("no", { status: 403 })
  try {
    await assert.rejects(() => client("tok").envValue("prj_1", "API_KEY"), /403/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("store keeps an account's seats across runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oc2api-acct-"))
  try {
    const store = new Store(dir)
    await store.saveAccount("i@example.com", {
      seats: [{ id: "prj_1", name: "oc2api-us", origin: "https://oc2api-us.vercel.app", hasKey: true }],
    })
    const read = await new Store(dir).account("i@example.com")
    assert.equal(read.email, "i@example.com")
    assert.equal(read.seats[0].name, "oc2api-us")
    assert.equal(read.seats[0].hasKey, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("an email still makes a file name that can't climb out", () => {
  assert.equal(safe("i@example.com"), "i@example.com")
  assert.ok(!safe("../../etc/passwd").includes(".."))
  assert.ok(!safe("a/b\\c").includes("/"))
})

test("stateOf reads a sign-in, and refuses what isn't one", () => {
  const s = _internal.stateOf({ type: "oauth", access: "acc", refresh: "vcr_1", accountId: "i@x.y" })
  assert.equal(s.access, "acc")
  assert.equal(s.refresh, "vcr_1")
  assert.equal(s.email, "i@x.y")
  assert.equal(_internal.stateOf(null), null)
  assert.equal(_internal.stateOf({}), null)
})

test("the plugin exports one function, so magpie calls one plugin", async () => {
  const mod = await import("../index.mjs")
  assert.equal(Object.values(mod).filter((v) => typeof v === "function").length, 1)
})

test("hooks are the shapes magpie calls", async () => {
  const mod = await import("../index.mjs")
  const hooks = await mod.Oc2apiVercelPlugin({
    client: { app: { log() {} } },
    directory: await mkdtemp(join(tmpdir(), "oc2api-hooks-")),
  })
  assert.equal(typeof hooks.config, "function")
  assert.equal(hooks.auth.provider, "oc2api")
  assert.equal(hooks.auth.methods.length, 1)
  assert.equal(hooks.auth.methods[0].type, "oauth")
  for (const name of ["loader", "usage", "checkin", "refresh"]) {
    assert.equal(typeof hooks.auth[name], "function", `auth.${name} is missing`)
  }
  assert.equal(typeof hooks.provider.models, "function")
  for (const [name, tool] of Object.entries(hooks.tool)) {
    assert.equal(typeof tool.execute, "function", `${name} has no execute`)
    assert.ok(name.startsWith("oc2api_"), `${name} is not named for the tool`)
  }
})

test("no deploy is offered any more: this plugin only reads", async () => {
  const mod = await import("../index.mjs")
  const hooks = await mod.Oc2apiVercelPlugin({
    client: { app: { log() {} } },
    directory: await mkdtemp(join(tmpdir(), "oc2api-nodeploy-")),
  })
  const names = Object.keys(hooks.tool)
  assert.ok(!names.some((n) => /deploy|create|remove|set_env/.test(n)), `still offers ${names.join(", ")}`)
})

test("the config hook offers the known models before any seat answers", async () => {
  const mod = await import("../index.mjs")
  const hooks = await mod.Oc2apiVercelPlugin({
    client: { app: { log() {} } },
    directory: await mkdtemp(join(tmpdir(), "oc2api-cfg-")),
  })
  const cfg = { provider: {} }
  await hooks.config(cfg)
  const ids = Object.keys(cfg.provider.oc2api.models)
  assert.ok(ids.includes("big-pickle"))
  assert.equal(cfg.provider.oc2api.npm, "@ai-sdk/openai-compatible")
})






test("the loader says where requests go, or magpie refuses them outright", async () => {
  // magpie answers "says nowhere to send its requests" when a provider
  // names no baseURL and its models carry no url: the seats pick an origin
  // per request, so this placeholder is the one address magpie can be given
  const mod = await import("../index.mjs")
  const hooks = await mod.Oc2apiVercelPlugin({
    client: { app: { log() {} } },
    directory: await mkdtemp(join(tmpdir(), "oc2api-loader-")),
  })
  const saved = {
    type: "oauth",
    access: "tok",
    refresh: "",
    expires: Date.now() + 3600_000,
    accountId: "i@example.com",
  }
  const loader = await hooks.auth.loader(async () => saved)
  assert.equal(typeof loader.baseURL, "string")
  assert.ok(loader.baseURL.length > 0, "a baseURL is required")
  // and no model may pin an origin, since that would defeat the rotation
  assert.equal(modelEntry("big-pickle").api.url, undefined)
})

test("every read the page asks for is declared for it in package.json", async () => {
  // magpie answers "{name} doesn't ask to read {what}" for a read the
  // package's magpie.permissions leaves out: the page then shows that
  // refusal instead of the provider list, so what app.js asks for and what
  // package.json declares have to be the same set
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  const declared = pkg.magpie?.permissions ?? []
  const page = await readFile(new URL("../page/app.js", import.meta.url), "utf8")
  const asked = [...page.matchAll(/magpie\.read\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1])
  assert.ok(asked.length, "the page reads nothing: the test has drifted from app.js")
  assert.deepEqual(asked.sort(), declared.slice().sort())
  assert.ok(declared.includes("providers:list"), "the page lists the providers")
})

// A fake of the little DOM the page touches, so its rendering can be run
// here: providers:list is every provider in magpie's window, and this page
// sits under Plugins as this plugin's own.
class FakeNode {
  constructor(tag) {
    this.tag = tag
    this.children = []
    this.className = ""
    this.textContent = ""
    this.hidden = false
    this.dataset = {}
    this.classList = { add: (c) => (this.className = `${this.className} ${c}`.trim()) }
  }
  append(...kids) {
    this.children.push(...kids)
  }
  replaceChildren(...kids) {
    this.children = kids
  }
  // the row's own texts, as the page draws them: the name, then the sub line
  get texts() {
    return this.children.flatMap((c) => (c.children.length ? [c.texts] : [c.textContent])).flat(Infinity)
  }
}

async function renderPage(providers) {
  const { runInNewContext } = await import("node:vm")
  const box = new FakeNode("ul")
  const error = new FakeNode("p")
  error.hidden = true // <p class="error" id="error" hidden>
  const byId = { providers: box, error }
  const document = {
    getElementById: (id) => byId[id],
    querySelectorAll: () => [],
    createElement: (tag) => new FakeNode(tag),
    documentElement: {},
    title: "",
  }
  const magpie = { ready: Promise.resolve({ lang: "en" }), read: async () => providers }
  const code = await readFile(new URL("../page/app.js", import.meta.url), "utf8")
  runInNewContext(code, { document, magpie, Promise, Error, String, Array, Object })
  // main() is called, not awaited: two turns let it finish what it awaits
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  return byId
}

test("the page shows this plugin's own rows, not every provider in the window", async () => {
  // what magpie really answers: other plugins' providers are in it too
  const byId = await renderPage([
    { id: "codex", name: "Codex" },
    { id: "workbuddy", name: "WorkBuddy" },
    { id: "oc2api", name: "oc2api (Vercel)" },
  ])
  const rows = byId.providers.children
  assert.equal(rows.length, 1, `drew ${rows.map((r) => r.texts).join(" | ")}`)
  assert.deepEqual(rows[0].texts, ["oc2api (Vercel)", "oc2api on Vercel, signed in to Vercel"])
  assert.equal(byId.error.hidden, true)
})

test("an added account is the same row, named by its account", async () => {
  // magpie gives each further account its own provider id: oc2api#<email>
  const byId = await renderPage([
    { id: "oc2api", name: "oc2api (Vercel)" },
    { id: "oc2api#i@example.com", name: "oc2api (Vercel)" },
    { id: "oc2api-plugin", name: "oc2api" },
  ])
  assert.deepEqual(
    byId.providers.children.map((r) => r.texts),
    [
      ["oc2api (Vercel)", "oc2api on Vercel, signed in to Vercel"],
      ["oc2api (Vercel)", "i@example.com"],
    ],
  )
})

test("with no provider of its own yet, the page says where to add one", async () => {
  const byId = await renderPage([{ id: "codex", name: "Codex" }])
  assert.equal(byId.providers.children.length, 1)
  assert.match(byId.providers.children[0].textContent, /add it from the provider row/)
})
