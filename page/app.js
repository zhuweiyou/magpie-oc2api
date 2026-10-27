// The page: what this plugin is signed in to.
//
// magpie's page sandbox allows no network of its own and hands a page only
// the reads its package.json declares (magpie.permissions), so this page
// cannot list seats: it shows the providers and says where the seats are,
// which is the account card and the oc2api_seats tool. `providers:list` is
// declared there for it: a read the package leaves out is refused with
// "{name} doesn't ask to read {what}", which is what the page would show.

const TEXT = {
  en: {
    title: "oc2api on Vercel",
    lede: "Sign in to Vercel once: every project named oc2api* becomes a seat, rotated automatically.",
    how: "How it works",
    step1: "Sign in once per Vercel account in the provider row: magpie opens Vercel's own page, nothing is typed here.",
    step2: "Every Vercel project whose name mentions oc2api is taken as a seat, with its own exit IP and its own API_KEY read from Vercel.",
    step3: "Requests rotate over the seats, and a seat that is out of its free tier is skipped for the next one.",
    providers: "This plugin's provider",
    loading: "Reading…",
    none: "Not here yet: add it from the provider row above.",
    mine: "oc2api on Vercel, signed in to Vercel",
    limits:
      "This page can only read the names of your providers, and names the one this plugin owns: the seats, their exit IPs and their health are on that provider's account card, and in the oc2api_seats tool.",
    deploy: "This plugin never deploys or changes a project: it only reads.",
  },
  zh: {
    title: "oc2api on Vercel",
    lede: "登录一次 Vercel：所有名字含 oc2api 的项目都成为一个「号」，自动轮询。",
    how: "怎么用",
    step1: "在供应商那一行按 Vercel 账号登录一次：magpie 会打开 Vercel 自己的页面，这里不用输任何东西。",
    step2: "该账号下每个名字含 oc2api 的 Vercel 项目都是一个座位，各有自己的出口 IP，API_KEY 从 Vercel 读出。",
    step3: "请求在座位之间轮询，某个座位免费额度用完就自动跳过、换下一个。",
    providers: "这个插件的供应商",
    loading: "读取中…",
    none: "还不在这里：在上面那一行添加它。",
    mine: "oc2api on Vercel，已登录 Vercel",
    limits:
      "这个页面只能读到供应商的名字，只写出这个插件自己的那一个。座位、它们的出口 IP 和健康状态在那个供应商的账号卡片上，以及 oc2api_seats 工具里。",
    deploy: "这个插件从不部署、也不修改你的项目：它只读。",
  },
}

const t = (lang) => TEXT[String(lang || "en").split("-")[0]] || TEXT.en
const $ = (id) => document.getElementById(id)

// PROVIDER is the one id this plugin installs (index.mjs); magpie gives each
// extra account its own row beside it, as oc2api#<email>
const PROVIDER = "oc2api"
const mine = (id) => id === PROVIDER || id.startsWith(PROVIDER + "#")

async function main() {
  let lang = "en"
  try {
    const theme = await magpie.ready
    lang = theme?.lang || "en"
  } catch {}

  const words = t(lang)
  document.querySelectorAll("[data-t]").forEach((e) => {
    const v = words[e.dataset.t]
    if (v) e.textContent = v
  })
  document.title = words.title
  document.documentElement.lang = lang

  let list
  try {
    list = await magpie.read("providers:list")
  } catch (err) {
    $("error").hidden = false
    $("error").textContent = String(err?.message || err)
    return
  }

  // Only this plugin's own rows, never another plugin's provider: magpie's
  // providers:list is every provider in the window, and this page sits under
  // Plugins as this plugin's own, so listing Codex and the rest here would
  // read as this plugin poking at accounts it has nothing to do with.
  const all = (Array.isArray(list) ? list : Array.isArray(list?.providers) ? list.providers : []).filter(
    (p) => mine(String(p?.id ?? "")),
  )
  const box = $("providers")
  if (!all.length) {
    const li = document.createElement("li")
    li.className = "empty"
    li.textContent = words.none
    box.replaceChildren(li)
    return
  }

  box.replaceChildren(
    ...all.map((p) => {
      const id = String(p?.id ?? p?.name ?? "")
      const name = String(p?.name ?? id)
      const row = document.createElement("li")
      row.className = "row mine"
      const who = document.createElement("div")
      who.className = "who"
      const n = document.createElement("div")
      n.className = "name"
      n.textContent = name
      const sub = document.createElement("div")
      sub.className = "sub"
      // an extra account is the same provider with the account it was added
      // for; the bare id says nothing a reader can use
      sub.textContent = id === PROVIDER ? words.mine : id.slice(PROVIDER.length + 1)
      who.append(n, sub)
      row.append(who)
      return row
    }),
  )
}

main()
