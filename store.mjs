// State that outlives a request, kept in magpie's config directory.
//
// One file per Vercel account (an email), holding one list: the projects whose
// name mentions oc2api — where each answers, and the API_KEY Vercel gave back
// for it. The key is written down with the project so a run doesn't have to
// ask Vercel again: it changes only when someone sets it by hand, and the
// project saying 401 is what tells the plugin it did.
//
// One file, not one per project: the key is read once and rewritten only when
// it is known to have changed, so per-file writes bought nothing, and a
// directory of key files is more to read and to clean up than a list. The file
// holds a secret, so it is written 0600 (on Windows that is advisory; the file
// still sits under the user's own config directory).

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"

const ROOT = "oc2api-vercel"

// safe turns an email into a file name that every filesystem takes, and that
// can't climb out of the directory it names: a run of dots is collapsed,
// since ".." is a parent wherever it appears.
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

  #path(email) {
    return join(this.root, "accounts", safe(email) + ".json")
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
  async #writeJSON(path, value) {
    await mkdir(join(path, ".."), { recursive: true })
    const temp = path + ".tmp"
    await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
    await rename(temp, path)
    try {
      await chmod(path, 0o600)
    } catch {}
  }

  // account is one Vercel account's projects, as they were last written: each
  // with its origin and its API_KEY.
  async account(email) {
    const read = await this.#readJSON(this.#path(email), null)
    if (!read) return { email: String(email ?? ""), projects: [], readAt: 0 }
    return { ...read, projects: Array.isArray(read.projects) ? read.projects : [] }
  }

  async saveAccount(email, value) {
    const current = await this.account(email)
    const next = { ...current, ...value, email: String(email ?? current.email ?? ""), readAt: Date.now() }
    await this.#writeJSON(this.#path(email), next)
    return next
  }
}
