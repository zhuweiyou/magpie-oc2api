// State that outlives a request, kept in magpie's config directory.
//
// Everything here is per Vercel account (an email) and per project: one list
// of the account's projects — the projects whose name mentions oc2api, with
// where each answers — and the API_KEY Vercel gave back for a project. The
// key is written down so a run doesn't have to ask Vercel again: it changes
// only when someone sets it by hand, and the project saying 401 is what tells
// the plugin it did. It is kept in a file of its own, mode 0600, and only
// ever read back by this plugin.

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

  // account is the projects last read of a Vercel account. One list, not two:
  // an earlier version kept a `projects` map of the same projects in another
  // shape beside a `seats` list, and nothing read the map. A file written by
  // that version still has both, so `projects` read as a map (an object, not
  // a list) is taken as the old copy and ignored.
  async account(email) {
    const read = await this.#readJSON(join(this.root, "accounts", safe(email) + ".json"), null)
    if (!read) return { email: String(email ?? ""), projects: [], readAt: 0 }
    if (!Array.isArray(read.projects)) {
      // v0.2's file: the list is in `seats`, and the object in `projects` is
      // the second copy of it
      const { projects: _old, ...rest } = read
      return { ...rest, projects: Array.isArray(read.seats) ? read.seats : [] }
    }
    return read
  }

  async saveAccount(email, value) {
    const current = await this.account(email)
    const next = { ...current, ...value, email: String(email ?? current.email ?? ""), readAt: Date.now() }
    // `seats` is what v0.2 called the same list: not written again
    delete next.seats
    await this.#writeJSON(join(this.root, "accounts", safe(email) + ".json"), next)
    return next
  }

  // key is what Vercel answered for a project's API_KEY, or null when it was
  // never asked. A project with no API_KEY set is kept as a record with an
  // empty key: that is an answer too, and asking again every run would be
  // asking the same question.
  async key(projectId) {
    const r = await this.#readJSON(join(this.root, "keys", safe(projectId) + ".json"), null)
    if (!r || typeof r.key !== "string") return null
    return r
  }

  async saveKey(projectId, key, extra = {}) {
    const value = { key, projectId, createdAt: Date.now(), source: "vercel", ...extra }
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
