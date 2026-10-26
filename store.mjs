// State that outlives a request, kept in magpie's config directory.
//
// Everything here is per Vercel account (an email) and per project: the
// account's projects as they were last read, and, for a project whose
// API_KEY this plugin minted itself, the key. A key this plugin did not
// mint (one set by hand in the Vercel dashboard) is never stored here: it
// can't be read back from Vercel either, since the API only returns it
// encrypted, so a deploy that must keep it will leave it alone and only a
// deploy of a project with no recorded key writes a new one.

import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

const ROOT = "oc2api-vercel"

// safe turns an email or a project id into a file name that every
// filesystem takes, and that can't climb out of the directory it names:
// a run of dots is collapsed, since ".." is a parent wherever it appears.
export function safe(name) {
  const cleaned = String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._@-]+/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.]+/, "")
    .slice(0, 120)
  return cleaned || "_"
}

export class Store {
  constructor(directory) {
    this.directory = directory
    this.root = join(directory, ROOT)
  }

  async #ensure(dir) {
    await mkdir(dir, { recursive: true })
    return dir
  }

  async #readJSON(path, fallback) {
    try {
      return JSON.parse(await readFile(path, "utf8"))
    } catch {
      return fallback
    }
  }

  // #writeJSON replaces a file in one step: a half-written record left by a
  // stop in the middle would be worse than the old one.
  async #writeJSON(path, value, secret = false) {
    await this.#ensure(join(path, ".."))
    const temp = path + ".tmp"
    await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: secret ? 0o600 : 0o644 })
    await rename(temp, path)
    if (secret) {
      try {
        await chmod(path, 0o600)
      } catch {}
    }
  }

  // account is what was last read of a Vercel account: its projects and
  // which of them were deployed, and at which commit.
  async account(email) {
    return (await this.#readJSON(join(this.root, "accounts", safe(email) + ".json"), null)) ?? {
      email: String(email ?? ""),
      projects: {},
      readAt: 0,
    }
  }

  async saveAccount(email, value) {
    const current = await this.account(email)
    const next = { ...current, ...value, email: String(email ?? current.email ?? ""), readAt: Date.now() }
    await this.#writeJSON(join(this.root, "accounts", safe(email) + ".json"), next)
    return next
  }

  // key is the API_KEY this plugin minted for a project, or null when it
  // minted none (the project is signed in with one set by hand).
  async key(projectId) {
    const r = await this.#readJSON(join(this.root, "keys", safe(projectId) + ".json"), null)
    if (!r || typeof r.key !== "string" || !r.key) return null
    return r
  }

  async saveKey(projectId, key, extra = {}) {
    const value = { key, projectId, createdAt: Date.now(), source: "plugin", ...extra }
    await this.#writeJSON(join(this.root, "keys", safe(projectId) + ".json"), value, true)
    return value
  }

  async forgetKey(projectId) {
    await rm(join(this.root, "keys", safe(projectId) + ".json"), { force: true })
  }

  // keys lists every project this plugin minted a key for, by project id.
  async keys() {
    const dir = join(this.root, "keys")
    let names
    try {
      names = await readdir(dir)
    } catch {
      return {}
    }
    const out = {}
    for (const name of names) {
      if (!name.endsWith(".json")) continue
      const r = await this.#readJSON(join(dir, name), null)
      if (r?.projectId && typeof r.key === "string") out[r.projectId] = r
    }
    return out
  }
}
