// Vercel's sign-in (OIDC device flow) and the parts of its REST API this
// plugin needs.
//
// The device flow is the one Vercel's own CLI uses, so nothing here is a
// private endpoint: the discovery document names the two URLs, and the
// client id is the CLI's public one, which Vercel allows for exactly this.

const ISSUER = "https://vercel.com"
const CLIENT_ID = "cl_HYyOPBNtFMfHhaUn9L4QPfTZz6TP47bp" // Vercel CLI's public client
const API = "https://api.vercel.com"
const UA = "magpie-oc2api/0.1.0"

let discovery = null

async function endpoints() {
  if (discovery) return discovery
  const res = await fetch(ISSUER + "/.well-known/openid-configuration", {
    headers: { accept: "application/json", "user-agent": UA },
  })
  if (!res.ok) throw new Error(`Vercel's sign-in discovery answered ${res.status}`)
  const d = await res.json()
  if (typeof d.device_authorization_endpoint !== "string" || typeof d.token_endpoint !== "string") {
    throw new Error("Vercel's sign-in discovery didn't name its endpoints")
  }
  discovery = {
    device: d.device_authorization_endpoint,
    token: d.token_endpoint,
    revoke: typeof d.revocation_endpoint === "string" ? d.revocation_endpoint : "",
  }
  return discovery
}

const form = (o) => new URLSearchParams(o).toString()

// oauthError is a token endpoint refusal, with the code Vercel gave it:
// authorization_pending and slow_down are the flow's own pacing, the rest
// end it.
function oauthError(json, status) {
  const code = String(json?.error ?? "")
  const why = String(json?.error_description ?? "")
  const e = new Error(code ? `${code}${why ? `: ${why}` : ""}` : `token endpoint answered ${status}`)
  e.code = code
  e.status = status
  return e
}

// startDevice asks for a code the user types at Vercel, which is the whole
// of the browser half: nothing listens on this machine.
export async function startDevice() {
  const { device } = await endpoints()
  const res = await fetch(device, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
    body: form({ client_id: CLIENT_ID, scope: "openid offline_access" }),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok || !json) throw oauthError(json, res.status)
  if (typeof json.device_code !== "string" || typeof json.user_code !== "string") {
    throw new Error("Vercel's sign-in answered without a code")
  }
  const verify = String(json.verification_uri_complete || json.verification_uri || "")
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verify,
    expiresAt: Date.now() + (Number(json.expires_in) || 600) * 1000,
    interval: Math.max(1, Number(json.interval) || 5) * 1000,
  }
}

// pollDevice asks for the token until the user finishes at Vercel, the
// code runs out, or signal is aborted. `onWait` hears each pending poll so
// a long wait can be reported.
export async function pollDevice(device, { signal, onWait } = {}) {
  const { token } = await endpoints()
  let interval = device.interval
  while (Date.now() < device.expiresAt) {
    if (signal?.aborted) throw new Error("the sign-in was cancelled")
    await sleep(interval, signal)
    let res, json
    try {
      res = await fetch(token, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
        body: form({
          client_id: CLIENT_ID,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: device.deviceCode,
        }),
        signal: AbortSignal.timeout(15_000),
      })
      json = await res.json().catch(() => null)
    } catch (e) {
      // a hiccup isn't an answer: ask again, a little slower
      if (signal?.aborted) throw new Error("the sign-in was cancelled")
      interval = Math.min(interval * 2, 15_000)
      onWait?.(e)
      continue
    }
    if (res.ok && typeof json?.access_token === "string") return json
    const err = oauthError(json, res.status)
    if (err.code === "authorization_pending") {
      onWait?.(err)
      continue
    }
    if (err.code === "slow_down") {
      interval += 5_000
      onWait?.(err)
      continue
    }
    throw err
  }
  throw new Error("Vercel's code ran out before the sign-in finished")
}

// refreshToken trades a refresh token for a new pair, as Vercel's CLI
// keeps a session alive.
export async function refreshToken(refresh) {
  const { token } = await endpoints()
  const res = await fetch(token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
    body: form({ client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: refresh }),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok || !json?.access_token) throw oauthError(json, res.status)
  return json
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(t)
      reject(new Error("the sign-in was cancelled"))
    }
    signal?.addEventListener?.("abort", onAbort, { once: true })
  })

// api calls Vercel with an account's access token. A refusal that names
// the token (401, or 403 with its own wording) is raised as SignInError so
// the caller can mark the account instead of blaming the request.
export class SignInError extends Error {
  constructor(message) {
    super(message)
    this.signIn = "expired"
  }
}

export function client(access) {
  async function call(path, { method = "GET", body, query, raw, tokenOnly = false } = {}) {
    const url = new URL(path.startsWith("http") ? path : API + path)
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v))
    }
    const headers = { authorization: `Bearer ${access}`, "user-agent": UA, accept: "application/json" }
    let payload
    if (body !== undefined) {
      headers["content-type"] = "application/json"
      payload = JSON.stringify(body)
    }
    const res = await fetch(url, { method, headers, body: payload })
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {}
    if (!res.ok) {
      const why = json?.error?.message || json?.message || json?.error || text?.slice(0, 300) || ""
      if (res.status === 401) throw new SignInError(`Vercel refused the sign-in: ${why || 401}`)
      if (res.status === 403 && /token|auth|forbidden|scope|permission/i.test(String(why))) {
        throw new SignInError(`Vercel refused the sign-in: ${why}`)
      }
      const e = new Error(`Vercel answered ${res.status}${why ? `: ${why}` : ""}`)
      e.status = res.status
      e.code = json?.error?.code ?? json?.code
      throw e
    }
    return raw ? text : json
  }

  return {
    call,

    // user names the account: the email is what magpie shows and what
    // tells two accounts apart.
    async user() {
      const u = (await call("/v2/user"))?.user ?? {}
      return { id: u.id ?? "", email: u.email ?? "", username: u.username ?? "", name: u.name ?? "" }
    },

    async teams() {
      const list = (await call("/v2/teams", { query: { limit: 100 } }))?.teams ?? []
      return list.map((t) => ({ id: t.id, slug: t.slug, name: t.name }))
    },

    // projects reads every project of the account, through all the pages:
    // a first page of a hundred would hide the rest.
    async projects() {
      const out = []
      let until
      for (let page = 0; page < 40; page++) {
        const r = await call("/v9/projects", { query: { limit: 100, until } })
        const list = r?.projects ?? []
        out.push(...list)
        const next = r?.pagination?.next
        if (next === null || next === undefined || !list.length) break
        until = next
      }
      return out.map(shapeProject)
    },

    // The rest of this client reads. There is no write in it on purpose:
    // this plugin signs in, lists projects and reads their API_KEY, and
    // nothing it does changes a project.
    async envs(projectId) {
      const r = await call(`/v10/projects/${encodeURIComponent(projectId)}/env`)
      return r?.envs ?? []
    },

    // envValue is what a production build would see of one variable. This is
    // the call `vercel env pull` makes, and the only way to read a key back:
    // the env list above holds every value encrypted.
    async envValue(projectId, key, target = "production") {
      const r = await call(`/v3/env/pull/${encodeURIComponent(projectId)}/${encodeURIComponent(target)}`)
      const fromEnv = r?.env?.[key]
      const fromBuild = r?.buildEnv?.[key]
      const value = typeof fromEnv === "string" ? fromEnv : typeof fromBuild === "string" ? fromBuild : ""
      return value
    },
  }
}

// shapeProject keeps what the plugin uses, so a cached copy stays small.
// `origin` is where the project answers, which is its production alias: that
// alias is stable across deployments, where a deployment's own URL is not.
export function shapeProject(p) {
  const prod = p?.targets?.production ?? null
  const aliases = Array.isArray(prod?.alias) ? prod.alias : []
  const host = aliases.find((a) => a.endsWith(".vercel.app")) || aliases[0] || ""
  return {
    id: p?.id ?? "",
    name: p?.name ?? "",
    nodeVersion: p?.nodeVersion ?? "",
    framework: p?.framework ?? null,
    accountId: p?.accountId ?? "",
    createdAt: p?.createdAt ?? 0,
    origin: host ? `https://${host}` : "",
    productionState: prod?.readyState ?? "",
    productionId: prod?.id ?? "",
    gitRepo:
      p?.link?.type === "github" ? `${p.link.org || p.link.repoOwnerId || ""}/${p.link.repo ?? ""}` : "",
    gitBranch: p?.link?.productionBranch ?? "",
  }
}
