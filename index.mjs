// oc2api on Vercel, as an OpenCode provider plugin for magpie — reading only.
//
// One magpie account is one Vercel account. Every Vercel project of that
// account whose name mentions oc2api is taken as a seat: its own origin, its
// own API_KEY (read from Vercel, never written), and its own exit IP. When
// this plugin asks for a model, a seat is chosen, so the free tier that
// oc2api measures per exit is spread over all of them, and a seat that says
// it is out is skipped for the next one. That is what several oc2api
// deployments on Vercel are for.
//
// Nothing is deployed and no project is changed: authorization is the whole
// of the setup. A key set by hand stays the key; a project with no key is
// used without one.

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Store } from "./store.mjs"
import { client, refreshToken, startDevice, pollDevice, SignInError } from "./vercel.mjs"
import { seatsOf, choose, healthy, restFor, wakeAt, Seats } from "./seats.mjs"
import * as models from "./models.mjs"

const PROVIDER = "oc2api"
const VERSION = "0.2.1"

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
// seat it picked. magpie insists a provider say where its requests go, and
// this plugin can't name one seat before the request is made.
const PLACEHOLDER = "https://seats.oc2api.invalid"

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

  // Seats are read per Vercel account and kept for a minute: every model
  // list and every request asks for them, and Vercel asks for none of that
  // rate. A request that finds a seat down re-reads them instead of trusting
  // the copy.
  const pools = new Map() // email -> { seats: Seats, at, keysAt }
  const SEATS_TTL = 60_000
  const KEYS_TTL = 30 * 60_000

  // seatList reads the account's projects and their keys. A key read is
  // worth 30 minutes of memory: it changes only when someone sets it by hand
  // in Vercel, and reading five of them on every request would be rude.
  async function seatList(auth, api, { force = false } = {}) {
    const email = auth.email || "account"
    const held = pools.get(email)
    const now = Date.now()
    if (!force && held && now - held.at < SEATS_TTL) return held.seats

    const projects = await api.projects()
    const next = seatsOf(projects)
    const seats = held?.seats ?? new Seats()
    seats.replace(next)

    const readingKeys = !held || force || now - held.keysAt > KEYS_TTL
    if (readingKeys) {
      // one at a time: five parallel reads of env is what tripped a connect
      // limit during development, and this runs once every half hour
      for (const seat of seats.list) {
        try {
          seat.key = await api.envValue(seat.id, "API_KEY")
        } catch {
          seat.key = ""
        }
      }
    }

    pools.set(email, { seats, at: now, keysAt: readingKeys ? now : held?.keysAt ?? now })
    await store
      .saveAccount(email, {
        userId: auth.userId,
        username: auth.username,
        seats: seats.list.map((s) => ({ id: s.id, name: s.name, origin: s.origin, hasKey: !!s.key })),
      })
      .catch(() => {})
    return seats
  }

  // forEachSeat runs work against the seats in turn until one answers: the
  // shape of both a model-list read and a request.
  async function withSeat(auth, api, work) {
    const seats = await seatList(auth, api)
    const open = seats.list.filter((s) => s.ok)
    if (!open.length) throw new Error("Vercel shows no project named oc2api*")
    return { seats, open }
  }

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      const was = cfg.provider[PROVIDER] ?? {}
      cfg.provider[PROVIDER] = {
        name: "oc2api (Vercel)",
        npm: "@ai-sdk/openai-compatible",
        ...was,
        // what to show before any seat has answered; the models hook
        // replaces it with the list a seat serves
        models: { ...models.table(models.KNOWN), ...(was.models ?? {}) },
      }
    },

    provider: {
      id: PROVIDER,
      // One seat's list stands for all of them: every project runs the same
      // oc2api, so every project serves the same models.
      async models(provider, { auth: saved } = {}) {
        const auth = stateOf(saved)
        if (!auth) return provider.models
        const api = client(auth.access)
        try {
          const seats = await seatList(auth, api)
          const read = await models.readAny(seats.list.filter((s) => s.ok))
          if (!read) {
            const fell = { ...provider.models }
            fell[Symbol.for("magpie.fellBack")] = true
            return fell
          }
          for (const seat of seats.list) if (read.ids.length) seat.ok = true
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

      // The request path: pick a seat, send, and on a refusal that is about
      // this seat (its key, or the free tier measured on its exit) try the
      // next one. A 429 or 403 arrives before any body is streamed, so
      // moving on can't cut an answer in half.
      async loader(getAuth) {
        const state = stateOf(await getAuth())
        if (!state) return {}

        return {
          // magpie needs somewhere to send the request, and which seat that
          // is only becomes known per request, so this is a marker rather
          // than an address: the fetch below rewrites it onto whichever seat
          // is chosen. Without it magpie refuses the request outright
          // ("says nowhere to send its requests").
          baseURL: PLACEHOLDER,
          apiKey: "oc2api", // a placeholder; the seat's own key is set below
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

            let pool = await seatList(auth, api)
            let seats = pool.list
            if (!seats.length) throw new Error("Vercel shows no project named oc2api* on this account")

            // a model may name its project (a request addressed at one
            // project's host); otherwise every seat is fair game
            const wanted = seats.find((s) => {
              try {
                return new URL(s.origin).host === given.host
              } catch {
                return false
              }
            })
            if (wanted) pool = { list: [wanted], markOK() {}, markFailed() {} }

            const candidates = () => (wanted ? [wanted] : seats)

            // Every seat is resting: the free tier of each exit was spent and
            // each named when it comes back. Answer at once with that, rather
            // than spending a round trip on each seat to be told the same
            // thing again (a spent window is hours long, so nothing can have
            // recovered in between).
            const live = candidates().filter((s) => healthy(s))
            if (!live.length) {
              const back = candidates()
                .map((s) => wakeAt(s))
                .filter((t) => t > 0)
                .sort((a, b) => a - b)[0]
              const soon = back ? ` · earliest back in ${humanFor(back - Date.now())}` : ""
              const n = candidates().length
              throw Object.assign(
                new Error(`${n} oc2api ${n === 1 ? "seat" : "seats"} out of free tier${soon}`),
                { status: 429 },
              )
            }

            const avoid = new Set()
            let lastError = ""
            let retryAfter = ""
            let refreshedSeats = false

            for (let attempt = 0; attempt < Math.min(candidates().length, 6); attempt++) {
              const seat = choose(candidates(), avoid)
              if (!seat) break
              const target = new URL(given.pathname + given.search, seat.origin)
              const headers = new Headers(base.headers ?? {})
              headers.delete("x-api-key")
              headers.delete("host")
              if (seat.key) headers.set("authorization", `Bearer ${seat.key}`)
              else headers.delete("authorization")
              if (!headers.has("accept")) headers.set("accept", "text/event-stream, application/json")

              seat.busy++
              let res
              try {
                res = await fetch(target, { ...base, headers })
              } catch (e) {
                seat.busy--
                avoid.add(seat.id)
                pool.markFailed(seat, e.message)
                lastError = `${seat.name}: ${e.message}`
                continue
              }
              seat.busy--
              seat.sent++

              if (res.status === 401 || res.status === 403 || res.status === 429) {
                // this seat is out, not this request: the free tier is
                // measured per exit, so another project may still have room
                const text = await res.clone().text().catch(() => "")
                avoid.add(seat.id)
                // oc2api names the wait in Retry-After: rest exactly that
                // long, so the seat returns when the upstream said instead
                // of being retried too early or left out too long
                const rest = restFor(res)
                pool.markFailed(seat, `${res.status} ${text.slice(0, 120)}`, rest)
                lastError = `${seat.name}: ${res.status}`
                if (res.status === 429) retryAfter = String(Math.ceil(rest / 1000))

                // a 401 may only mean the key was set anew in Vercel: read
                // the seats once more before giving up on all of them
                if (res.status === 401 && !refreshedSeats && !wanted) {
                  refreshedSeats = true
                  pool = await seatList(auth, api, { force: true })
                  seats = pool.list
                  for (const s of seats) if (!s.ok) avoid.delete(s.id)
                }
                continue
              }

              pool.markOK(seat)
              // which seat answered, for the account card and for `magpie
              // quota`; magpie strips these before they reach the agent
              const out = new Response(res.body, {
                status: res.status,
                statusText: res.statusText,
                headers: res.headers,
              })
              try {
                out.headers.set("x-magpie-seat", seat.name)
              } catch {}
              return out
            }

            // Every seat refused. Say how many were tried, and when the
            // soonest one comes back: "429" alone reads like the request was
            // turned away once, when in truth the free tier of every exit was
            // spent, which is the one thing a reader needs to know.
            const tried = avoid.size
            const total = candidates().length
            const back = seats
              .map((s) => wakeAt(s))
              .filter((t) => t > 0)
              .sort((a, b) => a - b)[0]
            const soon = back ? ` · next seat in ${humanFor(back - Date.now())}` : ""
            const why =
              tried >= total
                ? `${total} oc2api ${total === 1 ? "seat" : "seats"} all refused (${lastError})${soon}`
                : `${lastError}${soon}`
            throw Object.assign(new Error(why), {
              status: 429,
              retryAfter,
            })
          },
        }
      },

      // The account card: how many seats there are, and how they are doing.
      async usage(getAuth) {
        const auth = stateOf(await getAuth())
        if (!auth) return { windows: [] }
        const api = client(auth.access)
        let seats
        try {
          seats = await seatList(auth, api)
        } catch (e) {
          if (e instanceof SignInError) throw e
          return { plan: "Vercel", error: `Vercel couldn't be read: ${e.message}`, windows: [] }
        }
        const list = seats.list
        if (!list.length) {
          return { plan: "Vercel", user: auth.email, error: "no Vercel project named oc2api*", windows: [] }
        }
        const down = list.filter((s) => !healthy(s))
        const out = {
          plan: `${list.length} seat${list.length === 1 ? "" : "s"}`,
          user: auth.email,
          windows: [],
        }
        if (down.length) {
          // when each comes back, so the wait is a number rather than a guess
          const backs = down.map((s) => `${s.name} in ${humanFor(wakeAt(s) - Date.now())}`)
          out.error = `sitting out: ${backs.join(", ")}`
        }
        // each seat's own line: what it is, how much this plugin has sent it,
        // and when a spent one returns
        out.windows = list.map((s) => {
          const up = healthy(s)
          return {
            name: s.name,
            used: 0,
            display: up
              ? `${s.sent} sent · ${s.key ? "key" : "no key"}`
              : `out of free tier · back in ${humanFor(wakeAt(s) - Date.now())}`,
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
          const seats = await seatList(auth, api, { force: true })
          if (!seats.list.length) {
            return { outcome: "ineligible", msg: `no Vercel project named oc2api* on ${auth.email}` }
          }
          const read = await models.readAny(seats.list.filter((s) => s.ok))
          const names = seats.list.map((s) => s.name).join(", ")
          if (!read) {
            return {
              outcome: "failed",
              msg: `found ${seats.list.length}: ${names}, but none answered /v1/models`,
            }
          }
          return {
            outcome: "claimed",
            msg: `${seats.list.length} seats: ${names} · ${read.ids.length} models (from ${read.from})`.slice(0, 480),
          }
        } catch (e) {
          if (e instanceof SignInError) throw e
          return { outcome: "failed", msg: e.message }
        }
      },
    },

    tool: {
      oc2api_seats: {
        description:
          "List the oc2api seats (Vercel projects) of this account: origin, whether a key was found, exit IP and how many requests each has taken.",
        args: {},
        async execute(args) {
          const auth = await authOf(args?.account)
          if (!auth) return "not signed in to Vercel"
          const api = client(auth.access)
          const seats = await seatList(auth, api, { force: true })
          if (!seats.list.length) return "no Vercel project named oc2api*"
          const lines = []
          for (const s of seats.list) {
            let ip = ""
            try {
              const res = await fetch(`${s.origin}/ip`, {
                headers: s.key ? { authorization: `Bearer ${s.key}` } : {},
                signal: AbortSignal.timeout(15_000),
              })
              ip = (await res.json())?.ip ?? ""
            } catch {}
            lines.push(
              [
                s.name,
                s.origin,
                s.key ? "key found" : "no key",
                ip ? `exit ${ip}` : "exit unknown",
                `${s.sent} sent`,
                healthy(s) ? "up" : "sitting out",
              ].join(" · "),
            )
          }
          return lines.join("\n")
        },
      },

      oc2api_models: {
        description: "List the models the oc2api seats serve, read from one of them.",
        args: {},
        async execute(args) {
          const auth = await authOf(args?.account)
          if (!auth) return "not signed in to Vercel"
          const api = client(auth.access)
          const seats = await seatList(auth, api)
          const read = await models.readAny(seats.list.filter((s) => s.ok))
          if (!read) return "none of the seats answered /v1/models"
          return `${read.ids.length} models, read from ${read.from}:\n` + read.ids.map((id) => "  " + id).join("\n")
        },
      },
    },
  }

  // magpie's tool hook is not handed an account: its ctx has the agent and
  // the abort signal, not a seat. Tools therefore read the sign-in magpie
  // stored, choosing the account by email when several are signed in.
  async function authOf(email) {
    let all
    try {
      all = JSON.parse(await readFile(join(directory, "plugin-auth.json"), "utf8"))
    } catch {
      return null
    }
    const wanted = String(email ?? "").trim().toLowerCase()
    const own = Object.keys(all).filter((k) => k === PROVIDER || k.startsWith(PROVIDER + "#"))
    for (const k of own) {
      const state = stateOf(all[k])
      if (!state) continue
      if (!wanted || state.email.toLowerCase() === wanted) return state
    }
    return null
  }
}

// Test hooks. Not a function, so magpie doesn't call it as a plugin.
export const _internal = { stateOf, PROVIDER }



