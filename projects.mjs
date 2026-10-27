// The projects: every Vercel project whose name mentions oc2api, each with
// its own origin and key.
//
// A project's API_KEY is read from Vercel rather than guessed: the env
// endpoint that a build sees hands back plaintext, so a key set by hand
// stays in use and this plugin never has to write one. A project that has
// none is used without a key, which works whenever the deployment is
// unauthenticated; if it isn't, the project says so and the next project is
// tried.

const MATCH = /oc2api/i

// projectsOf turns Vercel's project list into the projects this plugin
// spreads over: name-matched, with the production alias each one answers on.
//
// A record that came from the account file carries its key, so the key is not
// asked for again; one that came from Vercel's API carries none.
export function projectsOf(projects) {
  return projects
    .filter((p) => MATCH.test(p.name))
    .map((p) => ({
      id: p.id,
      name: p.name,
      origin: p.origin,
      key: typeof p.key === "string" ? p.key : "",
      // "the key is known": "" means Vercel was asked and had none, which is
      // an answer too, so a project with no API_KEY isn't asked every run
      asked: typeof p.key === "string",
      ok: true,
      why: "",
      // the pool's bookkeeping, reset whenever projects are re-read
      busy: 0,
      tried: 0,
      failedAt: 0,
      sent: 0,
    }))
    .filter((p) => p.origin)
}

// restFor says how long a failed project should sit out. oc2api answers a spent
// free tier with a 429 whose Retry-After names the window exactly, and that
// window is measured in hours (15 in practice), so guessing a couple of
// minutes would mean retrying a spent exit every two minutes all day: the
// project would be re-probed hundreds of times, and each probe risks the
// upstream counting it. So the header is followed, and only a project that
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

// healthy says whether a project may take a request now.
export function healthy(project, now = Date.now()) {
  return now - project.failedAt > (project.restMs ?? 10 * 60_000)
}

// wakeAt is when a resting project comes back, for the account card.
export function wakeAt(project) {
  if (!project.failedAt) return 0
  return project.failedAt + (project.restMs ?? 10 * 60_000)
}

// choose picks the project to send a request to: the least loaded among the
// healthy ones, and among equals the one that has sent least, so traffic
// spreads over every exit rather than piling on the first. `avoid` holds the
// projects this request has already failed on.
export function choose(projects, avoid = new Set(), now = Date.now()) {
  const open = projects.filter((s) => s.ok && !avoid.has(s.id))
  if (!open.length) return null
  const healthyOnes = open.filter((s) => healthy(s, now))
  const pool = healthyOnes.length ? healthyOnes : open
  return pool.reduce((best, s) => {
    if (!best) return s
    if (s.busy !== best.busy) return s.busy < best.busy ? s : best
    return s.sent < best.sent ? s : best
  }, null)
}

export class Projects {
  constructor() {
    this.list = []
    this.readAt = 0
  }

  get size() {
    return this.list.length
  }

  replace(list) {
    // Keep what belongs to the project rather than to this reading of the
    // Vercel list: the counters, the resting state, and the API_KEY with
    // whether the key is known. Vercel's own project list carries no key, so
    // a replace that took its records whole would lose the key of every
    // project that already had one.
    const before = new Map(this.list.map((p) => [p.id, p]))
    this.list = list.map((p) => {
      const old = before.get(p.id)
      if (!old) return p
      return {
        ...p,
        key: old.key,
        asked: old.asked,
        sent: old.sent,
        failedAt: old.failedAt,
        restMs: old.restMs,
        ok: old.ok,
        why: old.why,
      }
    })
    this.readAt = Date.now()
    return this.list
  }

  byId(id) {
    return this.list.find((p) => p.id === id)
  }

  byHost(host) {
    return this.list.find((p) => {
      try {
        return new URL(p.origin).host === host
      } catch {
        return false
      }
    })
  }

  markFailed(project, why, restMs = 10 * 60_000) {
    project.failedAt = Date.now()
    project.why = why
    project.restMs = restMs
  }

  markOK(project) {
    project.failedAt = 0
    project.why = ""
    project.ok = true
  }
}


