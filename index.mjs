// oc2api on Vercel, as an OpenCode provider plugin for magpie — reading only.
//
// One magpie account is one Vercel account. Every Vercel project of that
// account whose name mentions oc2api is used as one exit: its own origin and
// its own API_KEY. When this plugin asks for a model, one of them is chosen,
// so the free tier that oc2api measures per exit is spread over all of them,
// and a project that says it is out is skipped for the next one. That is what
// several oc2api deployments on Vercel are for.
//
// The projects and their keys are read from Vercel once and written down in
// magpie's config directory (keys in their own 0600 files), so a run — and
// every run after it — answers from disk instead of asking Vercel again. See
// projectList below for the two moments that do read Vercel.
//
// Nothing is deployed and no project is changed: authorization is the whole
// of the setup. A key set by hand stays the key; a project with no key is
// used without one.

import { Store } from "./store.mjs"
import { client, refreshToken, startDevice, pollDevice, SignInError } from "./vercel.mjs"
import { projectsOf, choose, healthy, restFor, wakeAt, Projects } from "./projects.mjs"
import * as models from "./models.mjs"

const PROVIDER = "oc2api"

// humanFor says a duration the way a person reads it, for the account card
// and for the error a spent tier comes back as.
function humanFor(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}

// PLACEHOLDER is the address magpie is told the requests go to. It is never
// dialled: loader.fetch takes the path and query off it and puts them on the
// project it picked. magpie insists a provider say where its requests go, and
// this plugin can't name one project before the request is made.
const PLACEHOLDER = "https://projects.oc2api.invalid"

// ---- a saved sign-in ---------------------------------------------------------------

// stateOf turns a saved sign-in back into what the rest of this file uses.
// `refresh` holds the OAuth refresh token; the account's own facts ride
// alongside it as fields magpie keeps as they were returned.
function stateOf(auth) {
  if (!auth || typeof auth !== "object") return null
  if (auth.type !== "oauth" && !auth.access) return null
  return {
    access: String(auth.access ?? ""),
    refresh: typeof auth.refresh === "string" ? auth.refresh : "",
    expires: Number(auth.expires ?? 0),
    email: String(auth.accountId || auth.email || ""),
    userId: String(auth.uid || ""),
    username: String(auth.username || ""),
  }
}

// ---- the plugin --------------------------------------------------------------------

export async function Oc2apiVercelPlugin({ client: magpie, directory }) {
  const log = (message, level = "info") => {
    try {
      magpie?.app?.log?.({ body: { service: "oc2api", level, message } })
    } catch {}
  }
  const store = new Store(directory)

  // The projects are read from Vercel rarely, and a run is served from what
  // is already known: the account file and the keys written beside it in the
  // plugin's directory. A Vercel account's projects and their API_KEY change
  // only when someone changes them there, which is not a thing to poll for.
  //
  // So: at the start of a run the list on disk answers at once, and a read of
  // Vercel is made quietly behind it — a success replaces both the list and
  // the file, a failure leaves the run working on what it had. Signing in
  // again reads it at once (a fresh account has nothing on disk), Check in
  // now reads it at once (that is what the button is for), and a project that
  // refuses its key (a 401) is the one thing that says a key was set anew.
  const pools = new Map() // email -> { projects, keys, read, refreshing }
  // fresh holds accounts that have just signed in: their next read of the
  // list is on the spot and not the quiet one behind a file
  const fresh = new Set()

  // keyOf is the API_KEY of one project: from the pool, else from disk, else
  // read from Vercel once and written down. A project with no API_KEY set is
  // written down as "" too, so the question is asked once and not again.
  async function keyOf(api, pool, project, { again = false } = {}) {
    if (!again) {
      if (pool.keys.has(project.id)) return pool.keys.get(project.id)
      const held = await store.key(project.id).catch(() => null)
      if (held) {
        pool.keys.set(project.id, held.key)
        return held.key
      }
    }
    // one at a time: five parallel reads of env is what tripped a connect
    // limit during development
    const key = await api.envValue(project.id, "API_KEY")
    pool.keys.set(project.id, key)
    await store.saveKey(project.id, key, { source: "vercel" }).catch(() => {})
    return key
  }

  // seed is what a run starts with: the account's projects as they were last
  // written down, and the keys beside them. No network: this is what makes
  // the first request after a restart cost nothing.
  async function seed(email) {
    const account = await store.account(email).catch(() => null)
    const projects = new Projects()
    projects.replace(projectsOf(Array.isArray(account?.projects) ? account.projects : []))
    const keys = new Map()
    for (const [id, rec] of Object.entries(await store.keys().catch(() => ({})))) {
      keys.set(id, typeof rec?.key === "string" ? rec.key : "")
    }
    for (const project of projects.list) project.key = keys.get(project.id) ?? ""
    return { projects, keys, read: false, refreshing: null }
  }

  // reread is the one read of Vercel: the account's projects, and every key
  // it does not know yet (or every key, when `again`: a 401 means one was set
  // anew). What came back is written down, so the next run needs no network.
  async function reread(auth, api, pool, { again = false } = {}) {
    pool.projects.replace(projectsOf(await api.projects()))
    // a project deleted in Vercel keeps nothing; one added carries no key yet
    for (const id of [...pool.keys.keys()]) if (!pool.projects.byId(id)) pool.keys.delete(id)
    for (const project of pool.projects.list) {
      try {
        project.key = await keyOf(api, pool, project, { again })
      } catch {
        // Vercel couldn't answer: keep the key already known rather than
        // sending the project out with none, which oc2api answers with a 401
        project.key = pool.keys.get(project.id) ?? project.key ?? ""
      }
    }
    pool.read = true
    await store
      .saveAccount(auth.email || "account", {
        userId: auth.userId,
        username: auth.username,
        projects: pool.projects.list.map((p) => ({ id: p.id, name: p.name, origin: p.origin, hasKey: !!p.key })),
      })
      .catch(() => {})
    return pool.projects
  }

  // projectList is the account's projects. `force` reads Vercel and waits for
  // it (Check in now, and a 401); otherwise the run is answered from what is
  // known, with one quiet read behind it the first time.
  async function projectList(auth, api, { force = false } = {}) {
    const email = auth.email || "account"
    let pool = pools.get(email)
    if (!pool) {
      pool = await seed(email)
      pools.set(email, pool)
    }
    if (force) return reread(auth, api, pool, { again: true })

    // fresh signed in, or nothing on disk: a list is needed now
    if (fresh.has(email) || !pool.projects.list.length) {
      fresh.delete(email)
      return reread(auth, api, pool)
    }

    // once per run, and never awaited: a failure leaves the run on what it
    // already had, which is the whole point of reading the file first
    if (!pool.read && !pool.refreshing) {
      pool.refreshing = reread(auth, api, pool, { again: false })
        .catch(() => {})
        .finally(() => {
          pool.refreshing = null
        })
    }
    return pool.projects
  }

  // withProject runs work against the projects in turn until one answers: the
  // shape of both a model-list read and a request.
  async function withProject(auth, api, work) {
    const projects = await projectList(auth, api)
    const open = projects.list.filter((p) => p.ok)
    if (!open.length) throw new Error("Vercel shows no project named oc2api*")
    return { projects, open }
  }

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      const was = cfg.provider[PROVIDER] ?? {}
      cfg.provider[PROVIDER] = {
        name: "oc2api (Vercel)",
        npm: "@ai-sdk/openai-compatible",
        ...was,
        // what to show before any project has answered; the models hook
        // replaces it with the list a project serves
        models: { ...models.table(models.KNOWN), ...(was.models ?? {}) },
      }
    },

    provider: {
      id: PROVIDER,
      // One project's list stands for all of them: every project runs the same
      // oc2api, so every project serves the same models.
      async models(provider, { auth: saved } = {}) {
        const auth = stateOf(saved)
        if (!auth) return provider.models
        const api = client(auth.access)
        try {
          const projects = await projectList(auth, api)
          const read = await models.readAny(projects.list.filter((p) => p.ok))
          if (!read) {
            const fell = { ...provider.models }
            fell[Symbol.for("magpie.fellBack")] = true
            return fell
          }
          for (const project of projects.list) if (read.ids.length) project.ok = true
          return models.table(read.ids.map((id) => ({ id })))
        } catch (e) {
          if (e instanceof SignInError) throw e
          const fell = { ...provider.models }
          fell[Symbol.for("magpie.fellBack")] = true
          return fell
        }
      },
    },

    auth: {
      provider: PROVIDER,
      refreshLead: 10 * 60 * 1000,
      methods: [
        {
          type: "oauth",
          label: "Sign in with Vercel",
          async authorize() {
            const device = await startDevice()
            return {
              url: device.verify,
              instructions: `Enter the code ${device.userCode} to let magpie use your oc2api projects on Vercel.`,
              method: "auto",
              async callback() {
                let tokens
                try {
                  tokens = await pollDevice(device, {
                    onWait: () => log("waiting for the Vercel sign-in to finish"),
                  })
                } catch (e) {
                  return { type: "failed", error: `Vercel sign-in: ${e.message}` }
                }
                let me = { email: "", id: "", username: "" }
                try {
                  me = await client(tokens.access_token).user()
                } catch {}
                const name = me.email || me.username
                if (!name) return { type: "failed", error: "Vercel didn't say which account signed in" }
                // a sign-in is the other moment a list is read at once: the
                // projects may have changed while this account was away, and
                // the pool it had is this run's guess at them
                pools.delete(name)
                fresh.add(name)
                return {
                  type: "success",
                  access: tokens.access_token,
                  refresh: tokens.refresh_token ?? "",
                  expires: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
                  accountId: name,
                  uid: me.id || undefined,
                  username: me.username || "",
                }
              },
            }
          },
        },
      ],

      async refresh(auth) {
        const state = stateOf(auth)
        if (!state?.refresh) return {}
        let tokens
        try {
          tokens = await refreshToken(state.refresh)
        } catch (e) {
          if (e.code === "invalid_grant" || e.status === 400 || e.status === 401) {
            throw Object.assign(new Error("Vercel no longer accepts this sign-in; sign in again"), {
              signIn: "expired",
            })
          }
          throw e
        }
        return {
          access: tokens.access_token,
          refresh: tokens.refresh_token ?? state.refresh,
          expires: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
        }
      },

      // The request path: pick a project, send, and on a refusal that is about
      // this project (its key, or the free tier measured on its exit) try the
      // next one. A 429 or 403 arrives before any body is streamed, so
      // moving on can't cut an answer in half.
      async loader(getAuth) {
        const state = stateOf(await getAuth())
        if (!state) return {}

        return {
          // magpie needs somewhere to send the request, and which project that
          // is only becomes known per request, so this is a marker rather
          // than an address: the fetch below rewrites it onto whichever project
          // is chosen. Without it magpie refuses the request outright
          // ("says nowhere to send its requests").
          baseURL: PLACEHOLDER,
          apiKey: "oc2api", // a placeholder; the project's own key is set below
          async fetch(input, init) {
            const auth = stateOf(await getAuth())
            if (!auth) throw new Error("not signed in to Vercel")
            const api = client(auth.access)
            const url = input instanceof Request ? input.url : String(input)
            const given = new URL(url)
            const base = { ...(init ?? {}) }
            if (input instanceof Request) {
              base.method ??= input.method
              base.headers ??= input.headers
            }

            let pool = await projectList(auth, api)
            let projects = pool.list
            if (!projects.length) throw new Error("Vercel shows no project named oc2api* on this account")

            // a model may name its project (a request addressed at one
            // project's host); otherwise every project is fair game
            const wanted = projects.find((p) => {
              try {
                return new URL(p.origin).host === given.host
              } catch {
                return false
              }
            })
            if (wanted) pool = { list: [wanted], markOK() {}, markFailed() {} }

            const candidates = () => (wanted ? [wanted] : projects)

            // Every project is resting: the free tier of each exit was spent and
            // each named when it comes back. Answer at once with that, rather
            // than spending a round trip on each project to be told the same
            // thing again (a spent window is hours long, so nothing can have
            // recovered in between).
            const live = candidates().filter((p) => healthy(p))
            if (!live.length) {
              const back = candidates()
                .map((p) => wakeAt(p))
                .filter((t) => t > 0)
                .sort((a, b) => a - b)[0]
              const soon = back ? ` · earliest back in ${humanFor(back - Date.now())}` : ""
              const n = candidates().length
              throw Object.assign(
                new Error(`${n} oc2api ${n === 1 ? "project" : "projects"} out of free tier${soon}`),
                { status: 429 },
              )
            }

            const avoid = new Set()
            let lastError = ""
            let retryAfter = ""
            let refreshedProjects = false

            for (let attempt = 0; attempt < Math.min(candidates().length, 6); attempt++) {
              const project = choose(candidates(), avoid)
              if (!project) break
              const target = new URL(given.pathname + given.search, project.origin)
              const headers = new Headers(base.headers ?? {})
              headers.delete("x-api-key")
              headers.delete("host")
              if (project.key) headers.set("authorization", `Bearer ${project.key}`)
              else headers.delete("authorization")
              if (!headers.has("accept")) headers.set("accept", "text/event-stream, application/json")

              project.busy++
              let res
              try {
                res = await fetch(target, { ...base, headers })
              } catch (e) {
                project.busy--
                avoid.add(project.id)
                pool.markFailed(project, e.message)
                lastError = `${project.name}: ${e.message}`
                continue
              }
              project.busy--
              project.sent++

              if (res.status === 401 || res.status === 403 || res.status === 429) {
                // this project is out, not this request: the free tier is
                // measured per exit, so another project may still have room
                const text = await res.clone().text().catch(() => "")
                avoid.add(project.id)
                lastError = `${project.name}: ${res.status}`

                // A 401 is about the key, not the free tier: it is the one
                // thing that says a key was set anew in Vercel. Ask Vercel
                // once for every key again, write down what it says, and let
                // this request try whatever changed. A project whose key comes
                // back the same is not going to start working, so it sits
                // out a minute instead of costing a round trip each request.
                if (res.status === 401) {
                  const sent = project.key
                  if (!refreshedProjects && !wanted) {
                    refreshedProjects = true
                    try {
                      pool = await projectList(auth, api, { force: true })
                      projects = pool.list
                    } catch {}
                  }
                  const now = projects.find((p) => p.id === project.id)
                  if (now && now.key !== sent) avoid.delete(project.id)
                  else if (now) pool.markFailed(now, "401 the key was refused", 60_000)
                  continue
                }

                // oc2api names the wait in Retry-After: rest exactly that
                // long, so the project returns when the upstream said instead
                // of being retried too early or left out too long
                const rest = restFor(res)
                pool.markFailed(project, `${res.status} ${text.slice(0, 120)}`, rest)
                if (res.status === 429) retryAfter = String(Math.ceil(rest / 1000))
                continue
              }

              pool.markOK(project)
              // which project answered, for the account card and for `magpie
              // quota`; magpie strips these before they reach the agent
              const out = new Response(res.body, {
                status: res.status,
                statusText: res.statusText,
                headers: res.headers,
              })
              try {
                out.headers.set("x-magpie-project", project.name)
              } catch {}
              return out
            }

            // Every project refused. Say how many were tried, and when the
            // soonest one comes back: "429" alone reads like the request was
            // turned away once, when in truth the free tier of every exit was
            // spent, which is the one thing a reader needs to know.
            const tried = avoid.size
            const total = candidates().length
            const back = projects
              .map((p) => wakeAt(p))
              .filter((t) => t > 0)
              .sort((a, b) => a - b)[0]
            const soon = back ? ` · next project in ${humanFor(back - Date.now())}` : ""
            const why =
              tried >= total
                ? `${total} oc2api ${total === 1 ? "project" : "projects"} all refused (${lastError})${soon}`
                : `${lastError}${soon}`
            throw Object.assign(new Error(why), {
              status: 429,
              retryAfter,
            })
          },
        }
      },

      // The account card: how many projects there are, and how they are doing.
      async usage(getAuth) {
        const auth = stateOf(await getAuth())
        if (!auth) return { windows: [] }
        const api = client(auth.access)
        let projects
        try {
          projects = await projectList(auth, api)
        } catch (e) {
          if (e instanceof SignInError) throw e
          return { plan: "Vercel", error: `Vercel couldn't be read: ${e.message}`, windows: [] }
        }
        const list = projects.list
        if (!list.length) {
          return { plan: "Vercel", user: auth.email, error: "no Vercel project named oc2api*", windows: [] }
        }
        const down = list.filter((p) => !healthy(p))
        const out = {
          plan: `${list.length} project${list.length === 1 ? "" : "s"}`,
          user: auth.email,
          windows: [],
        }
        if (down.length) {
          // when each comes back, so the wait is a number rather than a guess
          const backs = down.map((p) => `${p.name} in ${humanFor(wakeAt(p) - Date.now())}`)
          out.error = `sitting out: ${backs.join(", ")}`
        }
        // each project's own line: what it is, how much this plugin has sent it,
        // and when a spent one returns
        out.windows = list.map((p) => {
          const up = healthy(p)
          return {
            name: p.name,
            used: 0,
            display: up
              ? `${p.sent} sent · ${p.key ? "key" : "no key"}`
              : `out of free tier · back in ${humanFor(wakeAt(p) - Date.now())}`,
            span: 0,
          }
        })
        return out
      },

      // Not a daily check-in: the button re-reads Vercel, so a project added
      // or a key changed there shows up at once instead of in a minute.
      async checkin(getAuth) {
        const auth = stateOf(await getAuth())
        if (!auth) return { outcome: "failed", msg: "not signed in to Vercel" }
        const api = client(auth.access)
        try {
          const projects = await projectList(auth, api, { force: true })
          if (!projects.list.length) {
            return { outcome: "ineligible", msg: `no Vercel project named oc2api* on ${auth.email}` }
          }
          const read = await models.readAny(projects.list.filter((p) => p.ok))
          const names = projects.list.map((p) => p.name).join(", ")
          if (!read) {
            return {
              outcome: "failed",
              msg: `found ${projects.list.length}: ${names}, but none answered /v1/models`,
            }
          }
          return {
            outcome: "claimed",
            msg: `${projects.list.length} projects: ${names} · ${read.ids.length} models (from ${read.from})`.slice(0, 480),
          }
        } catch (e) {
          if (e instanceof SignInError) throw e
          return { outcome: "failed", msg: e.message }
        }
      },
    },
  }
}

// Test hooks. Not a function, so magpie doesn't call it as a plugin.
export const _internal = { stateOf, PROVIDER }



