// What models the seats serve, and what magpie shows for them.
//
// Every project runs the same oc2api, so the list is read from one of them
// and taken as the list all of them serve. Reading it from every project
// would say the same thing several times over and cost a request each.
//
// KNOWN is only what to show before any seat has answered, so the provider
// isn't empty while it is being read, and what to keep when a seat can't be
// reached at the moment its list was asked for.

export const KNOWN = [
  { id: "big-pickle", context: 200_000, output: 32_000, image: false },
  { id: "mimo-v2.6-flash-free", context: 200_000, output: 32_000, image: true },
  { id: "deepseek-v4.1-flash-free", context: 200_000, output: 32_000, image: true },
  { id: "glm-5.3-flash-free", context: 200_000, output: 32_000, image: true },
]

// passes says whether oc2api would let a model through at all: the proxy
// serves big-pickle and every id ending in -free.
export const passes = (id) => id === "big-pickle" || String(id).endsWith("-free")

// detailsOf fills in what the model list doesn't say, from the ids we know.
function detailsOf(id) {
  return KNOWN.find((k) => k.id === id) ?? { context: 200_000, output: 32_000, image: false }
}

// modelEntry is one model as magpie wants it. Its `api.url` is left out on
// purpose: the seats pick the origin per request, so a model doesn't belong
// to one project.
export function modelEntry(id) {
  const d = detailsOf(id)
  return {
    id,
    name: id,
    api: { id, npm: "@ai-sdk/openai-compatible" },
    limit: { context: d.context, output: d.output },
    capabilities: { reasoning: false, toolcall: true, attachment: !!d.image },
    free: true,
    cost: { input: 0, output: 0 },
    release_date: "",
  }
}

// table builds the provider's models from a list of ids.
//
// An id with a slash in it is refused here: it would be a project name
// leaked into the model list, which is what an earlier version of this
// plugin did (`oc2api-us/big-pickle`). The seats are an internal detail and
// a model is just a model, so nothing above this layer should ever see one.
export function table(list) {
  const out = {}
  for (const m of list) {
    const id = String(m?.id ?? "")
    if (!id || id.includes("/") || out[id]) continue
    out[id] = modelEntry(id)
  }
  return out
}

// read asks one seat what it serves. `key` may be empty, for a deployment
// that needs none.
export async function read(origin, key, { timeoutMs = 8000 } = {}) {
  if (!origin) return null
  const headers = { accept: "application/json" }
  if (key) headers.authorization = `Bearer ${key}`
  let res
  try {
    res = await fetch(`${origin}/v1/models`, { headers, signal: AbortSignal.timeout(timeoutMs) })
  } catch {
    return null
  }
  if (!res.ok) return null
  let json
  try {
    json = await res.json()
  } catch {
    return null
  }
  const data = Array.isArray(json?.data) ? json.data : []
  const ids = []
  for (const m of data) {
    const id = String(m?.id ?? "")
    if (!id || !passes(id)) continue
    if (!ids.includes(id)) ids.push(id)
  }
  return ids.length ? ids : null
}

// readAny asks the seats in turn until one answers, which is the list they
// all serve.
export async function readAny(seats, { timeoutMs = 8000 } = {}) {
  for (const seat of seats) {
    const ids = await read(seat.origin, seat.key, { timeoutMs })
    if (ids) return { ids, from: seat.name }
  }
  return null
}
