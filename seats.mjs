// The seats: every Vercel project whose name mentions oc2api, each with its
// own origin, key and exit IP.
//
// A project's API_KEY is read from Vercel rather than guessed: the env
// endpoint that a build sees hands back plaintext, so a key set by hand
// stays in use and this plugin never has to write one. A project that has
// none is used without a key, which works whenever the deployment is
// unauthenticated; if it isn't, the project says so and the next seat is
// tried.

const MATCH = /oc2api/i

// pick turns Vercel's project list into seats: name-matched, with the
// production alias each one answers on.
export function seatsOf(projects) {
  return projects
    .filter((p) => MATCH.test(p.name))
    .map((p) => ({
      id: p.id,
      name: p.name,
      origin: p.origin,
      key: "",
      ip: "",
      ok: true,
      why: "",
      // the pool's bookkeeping, reset whenever seats are re-read
      busy: 0,
      tried: 0,
      failedAt: 0,
      sent: 0,
    }))
    .filter((s) => s.origin)
}

// restFor says how long a failed seat should sit out. oc2api answers a spent
// free tier with a 429 whose Retry-After names the window exactly, and that
// window is measured in hours (15 in practice), so guessing a couple of
// minutes would mean retrying a spent exit every two minutes all day: the
// seat would be re-probed hundreds of times, and each probe risks the
// upstream counting it. So the header is followed, and only a seat that
// named nothing falls back to a short rest.
export function restFor(res) {
  const raw = res?.headers?.get?.("retry-after") ?? ""
  const secs = Number(String(raw).trim())
  if (Number.isFinite(secs) && secs > 0) return Math.min(secs, 24 * 3600) * 1000
  // Retry-After-Ms is oc2api's own, finer grained
  const ms = Number(String(res?.headers?.get?.("retry-after-ms") ?? "").trim())
  if (Number.isFinite(ms) && ms > 0) return Math.min(ms, 24 * 3600 * 1000)
  return 10 * 60_000
}

// healthy says whether a seat may take a request now.
export function healthy(seat, now = Date.now()) {
  return now - seat.failedAt > (seat.restMs ?? 10 * 60_000)
}

// wakeAt is when a resting seat comes back, for the account card.
export function wakeAt(seat) {
  if (!seat.failedAt) return 0
  return seat.failedAt + (seat.restMs ?? 10 * 60_000)
}

// choose picks the seat to send a request to: the least loaded among the
// healthy ones, and among equals the one that has sent least, so traffic
// spreads over every exit rather than piling on the first. `avoid` holds the
// seats this request has already failed on.
export function choose(seats, avoid = new Set(), now = Date.now()) {
  const open = seats.filter((s) => s.ok && !avoid.has(s.id))
  if (!open.length) return null
  const healthyOnes = open.filter((s) => healthy(s, now))
  const pool = healthyOnes.length ? healthyOnes : open
  return pool.reduce((best, s) => {
    if (!best) return s
    if (s.busy !== best.busy) return s.busy < best.busy ? s : best
    return s.sent < best.sent ? s : best
  }, null)
}

export class Seats {
  constructor() {
    this.list = []
    this.readAt = 0
  }

  get size() {
    return this.list.length
  }

  replace(list) {
    // keep the counters of seats that are still there, so a refresh doesn't
    // restart the spreading from the first one
    const before = new Map(this.list.map((s) => [s.id, s]))
    this.list = list.map((s) => {
      const old = before.get(s.id)
      return old ? { ...s, sent: old.sent, failedAt: old.failedAt } : s
    })
    this.readAt = Date.now()
    return this.list
  }

  byId(id) {
    return this.list.find((s) => s.id === id)
  }

  byHost(host) {
    return this.list.find((s) => {
      try {
        return new URL(s.origin).host === host
      } catch {
        return false
      }
    })
  }

  markFailed(seat, why, restMs = 10 * 60_000) {
    seat.failedAt = Date.now()
    seat.why = why
    seat.restMs = restMs
  }

  markOK(seat) {
    seat.failedAt = 0
    seat.why = ""
    seat.ok = true
  }
}


