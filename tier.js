import fs from "node:fs"
import path from "node:path"
import fetch from "node-fetch"
import plugin from "../../lib/plugins/plugin.js"
import { Meta } from "#miao"
import { Character, Weapon } from "#miao.models"
import { resolveGsReleaseName } from "../genshin/model/resolveGsReleaseName.js"

const PLUGIN = "genshin-tier"
const TTL_SEC = 7200

/** @typedef {'char' | 'weapon' | 'cons' | 'member'} TierMode */

const MODE_LABEL = {
  char: "角色",
  weapon: "武器",
  cons: "命座",
  member: "群友",
}

const BOARD_KIND = {
  char: "角色榜",
  weapon: "武器榜",
  cons: "命座榜",
  member: "群友榜",
}

/** 顺序与 TierMaker 模板一致 */
const TIER_ORDER = ["夯", "顶级", "人上人", "NPC", "拉完了"]
const TIER_SLUG = {
  夯: "h",
  顶级: "t",
  人上人: "r",
  NPC: "n",
  拉完了: "l",
}

let _releaseNamesCache
let _releaseWeaponNamesCache

function redisKey(botId, groupId) {
  return `genshin-tier:${botId}:${groupId}`
}

function migrateTiersShape(state) {
  if (!state?.tiers || typeof state.tiers !== "object") return state
  for (const k of TIER_ORDER) {
    if (!Array.isArray(state.tiers[k])) state.tiers[k] = []
  }
  return state
}

/**
 * 一群一场；旧数据：统一 key，或曾写入的 genshin-tier:char|weapon|cons:… 会迁入统一 key
 */
async function loadState(e) {
  const u = redisKey(e.self_id, e.group_id)
  let raw = await redis.get(u)
  if (!raw) {
    for (const mode of ["char", "weapon", "cons"]) {
      const alt = `genshin-tier:${mode}:${e.self_id}:${e.group_id}`
      const hit = await redis.get(alt)
      if (hit) {
        await redis.setEx(u, TTL_SEC, hit)
        await redis.del(alt)
        raw = hit
        break
      }
    }
  }
  if (!raw) return null
  try {
    const state = migrateTiersShape(JSON.parse(raw))
    if (!state.mode || !MODE_LABEL[state.mode]) state.mode = "char"
    return state
  } catch {
    return null
  }
}

async function saveState(e, state) {
  await redis.setEx(redisKey(e.self_id, e.group_id), TTL_SEC, JSON.stringify(state))
}

async function delState(e) {
  const u = redisKey(e.self_id, e.group_id)
  await redis.del(u)
  for (const mode of ["char", "weapon", "cons"]) {
    await redis.del(`genshin-tier:${mode}:${e.self_id}:${e.group_id}`)
  }
}

function releaseCharNames() {
  if (_releaseNamesCache) return _releaseNamesCache
  const set = new Set()
  Character.forEach(
    char => {
      if (char.game === "gs" && char.isRelease) set.add(char.name)
      return true
    },
    "release",
    "gs",
  )
  _releaseNamesCache = set
  return _releaseNamesCache
}

function releaseWeaponNames() {
  if (_releaseWeaponNamesCache) return _releaseWeaponNamesCache
  const set = new Set()
  /** 不用 Weapon.forEach：其内部 Meta.forEach 为 async 且未被 await，同步读缓存时集合尚未填满，未排位池会只剩 0～1 项 */
  const ids = Meta.getIds("gs", "weapon")
  for (const id of ids) {
    const w = Weapon.get(id, "gs")
    if (w && w.game === "gs") set.add(w.name)
  }
  _releaseWeaponNamesCache = set
  return _releaseWeaponNamesCache
}

const resolveGsChar = resolveGsReleaseName

/** 命座存储键 k:角色名:0..6 */
function consStorageKey(charName, c) {
  return `k:${charName}:${c}`
}

function parseConsStorageKey(s) {
  const m = typeof s === "string" && /^k:([^:]+):([0-6])$/.exec(s)
  if (!m) return null
  return { char: m[1], c: Number(m[2]) }
}

const CN_CONS = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
}

/** 中文数字命座后缀尝试顺序（先长后短避免歧义） */
const CN_CONS_SUFFIX_KEYS = ["零", "〇", "一", "两", "二", "三", "四", "五", "六"]

function consDisplay(char, c) {
  if (c === 6) return `${char}·满命`
  return `${char}·${c}命`
}

/**
 * 解析「角色+几命」类输入（去空格后匹配）
 * @returns {{ storage: string, display: string, kind: 'cons' } | null}
 */
function parseConsEntry(raw) {
  const s = String(raw ?? "")
    .replace(/\s+/g, "")
    .trim()
  if (!s) return null
  const pool = releaseCharNames()

  const finish = (charName, c) => {
    if (c < 0 || c > 6 || !pool.has(charName)) return null
    return {
      storage: consStorageKey(charName, c),
      display: consDisplay(charName, c),
      kind: "cons",
    }
  }

  if (s.endsWith("满命")) {
    const namePart = s.slice(0, -2)
    const char = resolveGsChar(namePart)
    if (!char) return null
    return finish(char, 6)
  }

  let m = s.match(/^(.+)[Cc]([0-6])$/)
  if (m) {
    const char = resolveGsChar(m[1])
    if (!char) return null
    return finish(char, Number(m[2]))
  }

  m = s.match(/^(.+)([0-6])命$/)
  if (m) {
    const char = resolveGsChar(m[1])
    if (!char) return null
    return finish(char, Number(m[2]))
  }

  for (const cn of CN_CONS_SUFFIX_KEYS) {
    const suf = `${cn}命`
    if (!s.endsWith(suf)) continue
    const namePart = s.slice(0, -suf.length)
    const char = resolveGsChar(namePart)
    if (!char) continue
    const c = CN_CONS[cn]
    if (c === undefined) continue
    return finish(char, c)
  }

  m = s.match(/^([0-6])命(.+)$/)
  if (m) {
    const char = resolveGsChar(m[2])
    if (!char) return null
    return finish(char, Number(m[1]))
  }

  for (const cn of CN_CONS_SUFFIX_KEYS) {
    const pre = `${cn}命`
    if (!s.startsWith(pre)) continue
    const rest = s.slice(pre.length)
    const char = resolveGsChar(rest)
    if (!char) continue
    const c = CN_CONS[cn]
    if (c === undefined) continue
    return finish(char, c)
  }

  return null
}

/**
 * 在指定模式下解析单条输入
 * @returns {{ storage: string, display: string, mode: TierMode } | null}
 */
function resolveTierTokenForMode(token, /** @type {TierMode} */ mode) {
  const t = String(token ?? "").trim()
  if (!t) return null

  if (mode === "char") {
    const canon = resolveGsChar(t)
    const pool = releaseCharNames()
    if (!canon || !pool.has(canon)) return null
    return { storage: canon, display: canon, mode: "char" }
  }

  if (mode === "weapon") {
    const w = Weapon.get(t, "gs")
    if (!w || w.game !== "gs") return null
    const wpool = releaseWeaponNames()
    if (!wpool.has(w.name)) return null
    return { storage: `w:${w.name}`, display: w.name, mode: "weapon" }
  }

  if (mode === "cons") {
    const hit = parseConsEntry(t)
    if (hit) return { storage: hit.storage, display: hit.display, mode: "cons" }
    const pool = releaseCharNames()
    const canon = resolveGsChar(t)
    if (canon && pool.has(canon)) {
      return { storage: consStorageKey(canon, 0), display: consDisplay(canon, 0), mode: "cons" }
    }
    return null
  }

  return null
}

function splitRoleTokens(raw) {
  return String(raw ?? "")
    .split(/[,，、\s]+/)
    .map(s => s.trim())
    .filter(Boolean)
}

/** 群友榜：存储键，避免同名冲突 */
function memberStorageKey(qq) {
  return `m:${String(qq)}`
}

function parseMemberStorageKey(key) {
  if (typeof key !== "string" || !key.startsWith("m:")) return null
  return key.slice(2)
}

function memberDisplayName(state, qq) {
  const s = state?.memberNames?.[String(qq)]
  return s || String(qq)
}

async function buildMemberSnapshot(e) {
  /** gml 缓存常为空，须走 get_group_member_list（与 quit 等插件一致） */
  let ml = null
  if (typeof e.group?.getMemberMap === "function") {
    try {
      ml = await e.group.getMemberMap()
    } catch {}
  }
  if (!ml || !(ml instanceof Map) || ml.size === 0) {
    ml = e.bot?.gml?.get(e.group_id)
    if (ml == null && e.group_id != null) {
      const gid = Number(e.group_id)
      if (!Number.isNaN(gid)) ml = e.bot?.gml?.get(gid)
    }
  }
  const memberPool = []
  const memberNames = {}
  if (!ml || !(ml instanceof Map)) return { memberPool, memberNames }
  for (const [uid, mem] of ml) {
    const id = String(uid)
    if (id === String(e.self_id)) continue
    memberPool.push(id)
    memberNames[id] = mem.card || mem.nickname || id
  }
  memberPool.sort((a, b) =>
    (memberNames[a] || a).localeCompare(memberNames[b] || b, "zh-CN"),
  )
  return { memberPool, memberNames }
}

/** 从消息段收集全部 @（顺序去重）；勿依赖 e.at（仅保留最后一个） */
function collectAtQqs(e) {
  const out = []
  const seen = new Set()
  const self = String(e.self_id)
  if (!e.message || !Array.isArray(e.message)) return out
  for (const seg of e.message) {
    if (seg?.type === "at" && seg.qq != null) {
      const q = String(seg.qq)
      if (q === self) continue
      if (seen.has(q)) continue
      seen.add(q)
      out.push(q)
    }
  }
  return out
}

function svgAvatarPlaceholder(label) {
  const t = String(label).replace(/[^\d]/g, "").slice(-2) || "?"
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120"><defs><linearGradient id="g" x1="0" y1="0" x2="100%" y2="100%"><stop offset="0%" stop-color="#2d3a4f"/><stop offset="100%" stop-color="#1a2332"/></linearGradient></defs><rect width="120" height="120" rx="60" fill="url(#g)"/><text x="60" y="72" text-anchor="middle" fill="#8b9cb3" font-size="26" font-family="sans-serif">${t}</text></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** 拉取 QQ 头像并转 data URL，避免渲染外链 qlogo 失败 */
async function resolveQqAvatarDataUrl(e, qq) {
  const id = Number(qq) || qq
  const urls = []
  try {
    const m = e.group?.pickMember?.(id)
    if (m && typeof m.getAvatarUrl === "function") {
      const u = await m.getAvatarUrl()
      if (u && typeof u === "string") urls.push(u)
    }
  } catch {}
  urls.push(
    `https://q.qlogo.cn/g?b=qq&s=640&nk=${id}`,
    `https://q.qlogo.cn/g?b=qq&s=0&nk=${id}`,
    `https://q.qlogo.cn/headimg_dl?dst_uin=${id}&spec=640`,
  )
  const ua =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": ua } })
      if (!res.ok) continue
      const ct = (res.headers.get("content-type") || "").split(";")[0].trim() || "image/jpeg"
      if (!/^image\//i.test(ct)) continue
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length < 80) continue
      return `data:${ct};base64,${buf.toString("base64")}`
    } catch {}
  }
  return svgAvatarPlaceholder(id)
}

/** 群友榜：开局预拉头像写入 state.memberFaces，后续出图只读缓存（避免每次排位重复请求） */
const MEMBER_FACE_PREFETCH_CONCURRENCY = 12

async function prefetchMemberFaces(e, state) {
  const pool = state.memberPool
  if (!pool?.length) return
  if (!state.memberFaces || typeof state.memberFaces !== "object") state.memberFaces = {}
  const need = pool.filter(qq => !state.memberFaces[String(qq)])
  for (let i = 0; i < need.length; i += MEMBER_FACE_PREFETCH_CONCURRENCY) {
    const batch = need.slice(i, i + MEMBER_FACE_PREFETCH_CONCURRENCY)
    const faces = await Promise.all(batch.map(qq => resolveQqAvatarDataUrl(e, qq)))
    batch.forEach((qq, j) => {
      state.memberFaces[String(qq)] = faces[j]
    })
  }
}

function memberFacesNeedPrefetch(state) {
  const pool = state.memberPool
  if (!pool?.length) return false
  const f = state.memberFaces
  if (!f || typeof f !== "object") return true
  return pool.some(qq => !f[String(qq)])
}

const MIAO_RES_ABS = `${process.cwd()}/plugins/miao-plugin/resources/`

function miaoCharFaceRel(name) {
  const char = Character.get(name, "gs")
  if (!char?.getImgs || !char.isRelease) return ""
  try {
    const imgs = char.getImgs()
    const raw = imgs.qFace || imgs.face || ""
    const rel = String(raw).replace(/^\//, "")
    if (!rel) return ""
    if (!fs.existsSync(MIAO_RES_ABS + rel)) return ""
    return rel
  } catch {
    return ""
  }
}

function miaoWeaponIconRel(weaponName) {
  const w = Weapon.get(String(weaponName).trim(), "gs")
  if (!w || w.game !== "gs") return ""
  try {
    const raw = w.imgs?.icon || w.img || ""
    const rel = String(raw)
      .replace(/^\//, "")
      .replace(/\\/g, "/")
    if (!rel) return ""

    const abs = path.join(MIAO_RES_ABS, ...rel.split("/").filter(Boolean))
    if (fs.existsSync(abs)) return rel

    if (rel.endsWith(".webp")) {
      const relPng = rel.slice(0, -5) + ".png"
      const absPng = path.join(MIAO_RES_ABS, ...relPng.split("/").filter(Boolean))
      if (fs.existsSync(absPng)) return relPng
    }

    // 仍返回喵喵元数据路径，供 file:// 页面加载（避免仅因 Node 侧路径/权限导致整图空白）
    return rel
  } catch {
    return ""
  }
}

/** 喵喵 CharImg：meta-gs/character/名/icons/cons-1..6.webp（见 models/character/CharImg.js） */
function miaoConsIconRel(charName, c) {
  if (c < 1 || c > 6) return ""
  const char = Character.get(charName, "gs")
  if (!char?.getImgs || !char.isRelease) return ""
  try {
    const imgs = char.getImgs()
    const raw = imgs[`cons${c}`]
    if (!raw) return ""
    const rel = String(raw).replace(/^\//, "")
    if (!rel || !fs.existsSync(MIAO_RES_ABS + rel)) return ""
    return rel
  } catch {
    return ""
  }
}

function consOverlayBadge(c) {
  if (c === 6) return "满"
  return String(c)
}

function mapTierChips(/** @type {TierMode} */ mode, storageKeys) {
  return storageKeys.map(key => {
    if (mode === "weapon") {
      const name = key.startsWith("w:") ? key.slice(2) : key
      return {
        name,
        face: miaoWeaponIconRel(name),
        isWeapon: true,
        isCons: false,
        consBadge: "",
        consUseArt: false,
      }
    }
    if (mode === "cons") {
      const p = parseConsStorageKey(key)
      const name = p ? consDisplay(p.char, p.c) : key
      if (!p) {
        return { name, face: "", isWeapon: false, isCons: true, consBadge: "", consUseArt: false }
      }
      const consArt = miaoConsIconRel(p.char, p.c)
      const face = consArt || miaoCharFaceRel(p.char)
      const consBadge = consArt ? "" : consOverlayBadge(p.c)
      return { name, face, isWeapon: false, isCons: true, consBadge, consUseArt: !!consArt }
    }
    return {
      name: key,
      face: miaoCharFaceRel(key),
      isWeapon: false,
      isCons: false,
      consBadge: "",
      consUseArt: false,
    }
  })
}

function memberChipFromCache(state, qq, face) {
  return {
    name: memberDisplayName(state, qq),
    face,
    faceIsData: true,
    isWeapon: false,
    isCons: false,
    consBadge: "",
    consUseArt: false,
    isMember: true,
  }
}

async function mapTierChipsAsync(e, /** @type {TierMode} */ mode, state, storageKeys) {
  if (mode === "member") {
    const faces = state.memberFaces
    const tasks = storageKeys.map(async key => {
      const qq = parseMemberStorageKey(key)
      if (!qq) return null
      const id = String(qq)
      let face = faces?.[id]
      if (!face) face = await resolveQqAvatarDataUrl(e, qq)
      return memberChipFromCache(state, qq, face)
    })
    const chips = await Promise.all(tasks)
    return chips.filter(Boolean)
  }
  return mapTierChips(mode, storageKeys)
}

function emptyTiers() {
  const o = {}
  for (const k of TIER_ORDER) o[k] = []
  return o
}

function removeEntryFromAllTiers(tiers, storageKey) {
  for (const k of TIER_ORDER) {
    tiers[k] = tiers[k].filter(n => n !== storageKey)
  }
}

function collectRankedSet(tiers) {
  const s = new Set()
  for (const k of TIER_ORDER) for (const n of tiers[k]) s.add(n)
  return s
}

function allConsStorageKeysSorted() {
  const pool = [...releaseCharNames()].sort((a, b) => a.localeCompare(b, "zh-CN"))
  const keys = []
  for (const name of pool) {
    for (let c = 0; c <= 6; c++) keys.push(consStorageKey(name, c))
  }
  return keys
}

async function renderBoard(e, state, extra = {}) {
  const mode = state.mode || "char"
  if (mode === "member" && memberFacesNeedPrefetch(state)) {
    await prefetchMemberFaces(e, state)
    await saveState(e, state)
  }
  const ranked = collectRankedSet(state.tiers)
  let unrankedKeys = []
  if (mode === "char") {
    unrankedKeys = [...releaseCharNames()]
      .filter(n => !ranked.has(n))
      .sort((a, b) => a.localeCompare(b, "zh-CN"))
  } else if (mode === "weapon") {
    unrankedKeys = [...releaseWeaponNames()]
      .map(n => `w:${n}`)
      .filter(k => !ranked.has(k))
      .sort((a, b) => a.slice(2).localeCompare(b.slice(2), "zh-CN"))
  } else if (mode === "member") {
    const pool = state.memberPool || []
    unrankedKeys = pool
      .filter(id => !ranked.has(memberStorageKey(id)))
      .sort((a, b) =>
        memberDisplayName(state, a).localeCompare(memberDisplayName(state, b), "zh-CN"),
      )
      .map(memberStorageKey)
  } else {
    unrankedKeys = allConsStorageKeysSorted().filter(k => !ranked.has(k))
  }

  const unrankedTotal = unrankedKeys.length
  const tierBlocks = await Promise.all(
    TIER_ORDER.map(async key => ({
      slug: TIER_SLUG[key],
      label: key,
      chips: await mapTierChipsAsync(e, mode, state, state.tiers[key]),
    })),
  )

  const unrankedShow = unrankedKeys.slice(0, 72)
  const data = {
    theme: state.theme || "未命名主题",
    boardKind: BOARD_KIND[mode] || "",
    tip: extra.tip || "",
    tierBlocks,
    unrankedRows: await mapTierChipsAsync(e, mode, state, unrankedShow),
    unrankedTotal,
    unrankedMore: Math.max(0, unrankedTotal - unrankedShow.length),
  }

  await e.runtime.render(PLUGIN, "tier/board", data)
}

async function startTierByMode(e, /** @type {TierMode} */ mode, themeRaw) {
  const theme = String(themeRaw ?? "")
    .trim()
    .slice(0, 80)
  if (!theme) {
    return e.reply(`请带上主题，例如：#${MODE_LABEL[mode]}从夯到拉 深渊强度`)
  }

  const ex = await loadState(e)
  if (ex) {
    const bk = BOARD_KIND[ex.mode] || "夯拉"
    return e.reply(`本群已有进行中的夯拉（${bk}），请先 #结束夯拉 再开新主题`)
  }

  const state = {
    mode,
    botId: e.self_id,
    groupId: e.group_id,
    theme,
    tiers: emptyTiers(),
  }

  if (mode === "member") {
    const snap = await buildMemberSnapshot(e)
    if (!snap.memberPool.length) {
      return e.reply("无法读取本群成员列表，请稍后重试")
    }
    state.memberPool = snap.memberPool
    state.memberNames = snap.memberNames
    state.memberFaces = {}
    await prefetchMemberFaces(e, state)
  }

  await saveState(e, state)
  let hint = ""
  if (mode === "char") {
    hint = "使用 #角色名排夯 等指令排位"
  } else if (mode === "weapon") {
    hint = "使用 #武器名排夯 等指令排位（喵喵图鉴名称）"
  } else if (mode === "member") {
    hint = "排位/飞榜请 @ 群成员；可直接发「排夯」等（可不写 #），或用 #排夯；重名不可仅靠打字"
  } else {
    hint = "使用 #钟离二命排夯、#6命纳西妲排夯、#胡桃满命排顶级 等（角色+命座）"
  }
  await renderBoard(e, state, {
    tip: `「${BOARD_KIND[mode]}」主题「${theme}」已创建，${hint}`,
  })
  return true
}

async function endTierSession(e) {
  const state = await loadState(e)
  if (!state) {
    return e.reply("当前没有进行中的夯拉")
  }
  await delState(e)
  const bk = BOARD_KIND[state.mode] || ""
  return e.reply(`已结束夯拉${bk ? `（${bk}）` : ""}「${state.theme}」`)
}

export class GenshinTier extends plugin {
  constructor() {
    super({
      name: "原神夯拉榜",
      dsc: "从夯到拉排行",
      event: "message",
      priority: 598,
      rule: [
        { reg: /^#武器从夯到拉\s+(.+)$/i, fnc: "startWeaponTier" },
        { reg: /^#命座从夯到拉\s+(.+)$/i, fnc: "startConsTier" },
        { reg: /^#群友从夯到拉\s+(.+)$/i, fnc: "startMemberTier" },
        { reg: /^#角色从夯到拉\s+(.+)$/i, fnc: "startCharTier" },
        { reg: /^#从夯到拉\s+(.+)$/i, fnc: "startCharTier" },
        {
          reg: /^#(?:结束角色夯拉|结束武器夯拉|结束命座夯拉|结束夯拉|重置夯拉)\s*$/i,
          fnc: "endTier",
        },
        {
          reg: /^#(?:其余角色|其他角色)\s*排(夯|顶级|人上人|NPC|拉完了)\s*$/i,
          fnc: "rankRestChars",
        },
        { reg: /^#\s*(.*?)\s*排(夯|顶级|人上人|NPC|拉完了)\s*$/i, fnc: "setRank" },
        {
          reg: /^(?!\s*#)\s*(.*?)\s*排(夯|顶级|人上人|NPC|拉完了)\s*$/i,
          fnc: "setRank",
        },
        { reg: /^#\s*(.*?)\s*(?:飞榜|爬|滚)\s*$/i, fnc: "flyOff" },
        { reg: /^(?!\s*#)\s*(.*?)\s*(?:飞榜|爬|滚)\s*$/i, fnc: "flyOff" },
        { reg: /^#夯拉帮助\s*$/i, fnc: "tierHelp" },
      ],
    })
  }

  async tierHelp() {
    await this.e.runtime.render(PLUGIN, "tier/help", {})
    return true
  }

  async startCharTier() {
    if (!this.e.isGroup) return this.reply("请在群内使用 #角色从夯到拉 主题名称（或 #从夯到拉）")
    const m = this.e.msg.match(/^#(?:角色从夯到拉|从夯到拉)\s+(.+)$/i)
    if (!m) return false
    return startTierByMode(this.e, "char", m[1])
  }

  async startWeaponTier() {
    if (!this.e.isGroup) return this.reply("请在群内使用 #武器从夯到拉 主题名称")
    const m = this.e.msg.match(/^#武器从夯到拉\s+(.+)$/i)
    if (!m) return false
    return startTierByMode(this.e, "weapon", m[1])
  }

  async startConsTier() {
    if (!this.e.isGroup) return this.reply("请在群内使用 #命座从夯到拉 主题名称")
    const m = this.e.msg.match(/^#命座从夯到拉\s+(.+)$/i)
    if (!m) return false
    return startTierByMode(this.e, "cons", m[1])
  }

  async startMemberTier() {
    if (!this.e.isGroup) return this.reply("请在群内使用 #群友从夯到拉 主题名称")
    const m = this.e.msg.match(/^#群友从夯到拉\s+(.+)$/i)
    if (!m) return false
    return startTierByMode(this.e, "member", m[1])
  }

  async endTier() {
    if (!this.e.isGroup) return false
    return endTierSession(this.e)
  }

  /** 主人专用：角色榜下将未排位池内全部实装角色一次性排入指定档 */
  async rankRestChars() {
    if (!this.e.isGroup) return false
    if (!this.e.isMaster) {
      return this.reply("「其余角色/其他角色排XX」仅机器人主人可使用")
    }

    const m = this.e.msg.match(/^#(?:其余角色|其他角色)\s*排(夯|顶级|人上人|NPC|拉完了)\s*$/i)
    if (!m) return false
    let tierKey = m[1]
    if (/^npc$/i.test(tierKey)) tierKey = "NPC"
    if (!TIER_ORDER.includes(tierKey)) return false

    const state = await loadState(this.e)
    if (!state) {
      return this.reply("当前没有进行中的夯拉")
    }
    const sm = state.mode || "char"
    if (sm !== "char") {
      return this.reply(
        sm === "member"
          ? "「其余角色排XX」不适用群友榜；群友榜请用 @ 逐个排位"
          : "该指令仅在「角色榜」下可用（当前为武器榜、命座榜或群友榜）",
      )
    }

    const ranked = collectRankedSet(state.tiers)
    const rest = [...releaseCharNames()]
      .filter(n => !ranked.has(n))
      .sort((a, b) => a.localeCompare(b, "zh-CN"))

    if (!rest.length) {
      return this.reply("当前没有仍处于未排位池的角色")
    }

    for (const name of rest) {
      removeEntryFromAllTiers(state.tiers, name)
      state.tiers[tierKey].push(name)
    }

    await saveState(this.e, state)
    await renderBoard(this.e, state, {
      tip: `（主人）已将 ${rest.length} 名未排位角色一次性排入「${tierKey}」`,
    })
    return true
  }

  async setRank() {
    if (!this.e.isGroup) return false

    const withHash = this.e.msg.match(/^#\s*(.*?)\s*排(夯|顶级|人上人|NPC|拉完了)\s*$/i)
    const noHash = !withHash && this.e.msg.match(/^(?!\s*#)\s*(.*?)\s*排(夯|顶级|人上人|NPC|拉完了)\s*$/i)
    const m = withHash || noHash
    if (!m) return false
    let tierKey = m[2]
    if (/^npc$/i.test(tierKey)) tierKey = "NPC"
    if (!TIER_ORDER.includes(tierKey)) return false

    const rawBlock = (m[1] || "").trim()
    const usedHash = Boolean(withHash)

    const state = await loadState(this.e)
    if (!state) {
      if (!usedHash) return false
      return this.reply("当前没有进行中的夯拉，请先 #角色从夯到拉 / #武器从夯到拉 / #命座从夯到拉 / #群友从夯到拉 主题")
    }

    const mode0 = state.mode || "char"
    if (!usedHash && mode0 !== "member") return false

    if (mode0 === "member") {
      const ats = collectAtQqs(this.e)
      if (!ats.length) {
        return this.reply("当前为「群友榜」，排位请使用 @群成员 指定对象（重名时请用艾特，勿仅靠打字）")
      }
      const poolSet = new Set(state.memberPool || [])
      const successes = []
      const errors = []
      const seen = new Set()

      for (const qq of ats) {
        if (!poolSet.has(qq)) {
          errors.push(`QQ ${qq} 不在本场开局时的群成员快照内`)
          continue
        }
        const sk = memberStorageKey(qq)
        if (seen.has(sk)) continue
        seen.add(sk)
        removeEntryFromAllTiers(state.tiers, sk)
        state.tiers[tierKey].push(sk)
        successes.push(memberDisplayName(state, qq))
      }

      if (!successes.length) {
        return this.reply(errors.length ? errors.join("\n") : "没有可排入的群友")
      }

      await saveState(this.e, state)
      let tip =
        successes.length > 1
          ? `批量排入「${tierKey}」：${successes.join("、")}`
          : `「${successes[0]}」→ ${tierKey}`
      if (errors.length) tip += `\n未执行：${errors.join("；")}`

      await renderBoard(this.e, state, { tip })
      return true
    }

    if (!rawBlock) {
      return this.reply("请指定至少一项，多个可用空格或 ，、 分隔")
    }

    const parts = splitRoleTokens(rawBlock)
    if (!parts.length) {
      return this.reply("请指定至少一项，多个可用空格或 ，、 分隔")
    }

    for (const token of parts) {
      if (!resolveTierTokenForMode(token, mode0)) {
        return this.reply(
          `当前为${BOARD_KIND[mode0]}，仅接受${MODE_LABEL[mode0]}条目；「${token}」无法识别（命座场请写如：钟离二命、胡桃满命，纯角色名表示 0 命）`,
        )
      }
    }

    const successes = []
    const errors = []
    const seen = new Set()

    for (const token of parts) {
      const hit = resolveTierTokenForMode(token, mode0)
      if (!hit) {
        errors.push(`「${token}」无法识别`)
        continue
      }
      if (seen.has(hit.storage)) continue
      seen.add(hit.storage)
      removeEntryFromAllTiers(state.tiers, hit.storage)
      state.tiers[tierKey].push(hit.storage)
      successes.push(hit.display)
    }

    if (!successes.length) {
      return this.reply(errors.length ? errors.join("\n") : "没有可排入的条目")
    }

    await saveState(this.e, state)
    let tip =
      successes.length > 1
        ? `批量排入「${tierKey}」：${successes.join("、")}`
        : `「${successes[0]}」→ ${tierKey}`
    if (errors.length) tip += `\n未执行：${errors.join("；")}`

    await renderBoard(this.e, state, { tip })
    return true
  }

  async flyOff() {
    if (!this.e.isGroup) return false

    const withHash = this.e.msg.match(/^#\s*(.*?)\s*(?:飞榜|爬|滚)\s*$/i)
    const noHash = !withHash && this.e.msg.match(/^(?!\s*#)\s*(.*?)\s*(?:飞榜|爬|滚)\s*$/i)
    const m = withHash || noHash
    if (!m) return false
    const rawBlock = (m[1] || "").trim()
    const usedHash = Boolean(withHash)

    const state = await loadState(this.e)
    if (!state) {
      if (!usedHash) return false
      return this.reply("当前没有进行中的夯拉")
    }

    const mode0 = state.mode || "char"
    if (!usedHash && mode0 !== "member") return false

    if (mode0 === "member") {
      const ats = collectAtQqs(this.e)
      if (!ats.length) {
        return this.reply("当前为「群友榜」，飞榜请使用 @群成员 指定对象（重名时请用艾特，勿仅靠打字）")
      }
      const poolSet = new Set(state.memberPool || [])
      const ranked = collectRankedSet(state.tiers)
      const successes = []
      const errors = []
      const seen = new Set()

      for (const qq of ats) {
        if (!poolSet.has(qq)) {
          errors.push(`QQ ${qq} 不在本场开局时的群成员快照内`)
          continue
        }
        const sk = memberStorageKey(qq)
        if (seen.has(sk)) continue
        seen.add(sk)
        const disp = memberDisplayName(state, qq)
        if (!ranked.has(sk)) {
          errors.push(`「${disp}」未在榜上`)
          continue
        }
        removeEntryFromAllTiers(state.tiers, sk)
        successes.push(disp)
      }

      if (!successes.length) {
        return this.reply(errors.length ? errors.join("\n") : "没有可飞榜的群友")
      }

      await saveState(this.e, state)
      let tip =
        successes.length > 1
          ? `批量飞榜：${successes.join("、")}`
          : `「${successes[0]}」已飞榜，可重新排位`
      if (errors.length) tip += `\n跳过：${errors.join("；")}`

      await renderBoard(this.e, state, { tip })
      return true
    }

    if (!rawBlock) {
      return this.reply("请指定至少一项，多个可用空格或 ，、 分隔")
    }

    const parts = splitRoleTokens(rawBlock)
    if (!parts.length) {
      return this.reply("请指定至少一项，多个可用空格或 ，、 分隔")
    }

    for (const token of parts) {
      if (!resolveTierTokenForMode(token, mode0)) {
        return this.reply(
          `当前为${BOARD_KIND[mode0]}，仅接受${MODE_LABEL[mode0]}条目；「${token}」无法识别`,
        )
      }
    }

    const ranked = collectRankedSet(state.tiers)
    const successes = []
    const errors = []
    const seen = new Set()

    for (const token of parts) {
      const hit = resolveTierTokenForMode(token, mode0)
      if (!hit) {
        errors.push(`「${token}」无法识别`)
        continue
      }
      if (seen.has(hit.storage)) continue
      seen.add(hit.storage)
      if (!ranked.has(hit.storage)) {
        errors.push(`「${hit.display}」未在榜上`)
        continue
      }
      removeEntryFromAllTiers(state.tiers, hit.storage)
      successes.push(hit.display)
    }

    if (!successes.length) {
      return this.reply(errors.length ? errors.join("\n") : "没有可飞榜的条目")
    }

    await saveState(this.e, state)
    let tip =
      successes.length > 1
        ? `批量飞榜：${successes.join("、")}`
        : `「${successes[0]}」已飞榜，可重新排位`
    if (errors.length) tip += `\n跳过：${errors.join("；")}`

    await renderBoard(this.e, state, { tip })
    return true
  }
}
