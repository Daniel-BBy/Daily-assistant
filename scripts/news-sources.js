/**
 * 新闻源层：抓取 → 时间窗 → AI 相关性 → 去重 → 打分。
 *
 * 这一层是纯规则，不花钱、可测试。LLM 只在后面负责"选和写"。
 *
 * 两个踩过的坑，注释留在对应位置：
 *   1. 英文关键词必须按词边界匹配（AI 会命中 Air / chair / Email）
 *   2. 排除词一票否决（否则"英伟达驱动 Bug"会被当成 AI 新闻）
 */

export const FEEDS = [
  { id: 'ithome', name: 'IT之家', url: 'https://www.ithome.com/rss/', weight: 1.0, hasBody: true },
  { id: 'qbitai', name: '量子位', url: 'https://www.qbitai.com/feed', weight: 2.0 },
  { id: 'infoq', name: 'InfoQ中文', url: 'https://www.infoq.cn/feed', weight: 1.0 },
  { id: 'sina', name: '新浪科技', url: 'https://rss.sina.com.cn/tech/rollnews.xml', weight: 0.8 },
  { id: 'tc', name: 'TechCrunch', url: 'https://techcrunch.com/category/artificial-intelligence/feed/', weight: 1.6 },
  { id: 'verge', name: 'The Verge', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', weight: 1.4 },
  { id: 'hn', name: 'Hacker News', url: 'https://hnrss.org/frontpage', weight: 1.2 },
]

export const STRONG = [
  'AI', '人工智能', '大模型', '大语言模型', 'LLM', 'GPT', 'ChatGPT', 'Sora',
  'OpenAI', 'Anthropic', 'Claude', 'Gemini', 'DeepMind', 'DeepSeek', 'Kimi',
  '月之暗面', '通义', '文心', '豆包', '混元', '智谱', 'MiniMax', 'Mistral',
  '智能体', 'Agent', '具身智能', '人形机器人', '机器人', '算力', '英伟达',
  'NVIDIA', 'H100', 'B200', 'GB200', 'TPU', '推理模型', '多模态', 'RAG', 'MCP',
  'Transformer', '扩散模型', '神经网络', '机器学习', '深度学习',
]

export const WEAK = [
  '融资', '收购', '估值', 'IPO', '发布', '上线', '推出', '开源', '芯片',
  '数据中心', '自动驾驶', '监管', '政策', '合规', '研究', '论文', '数据集',
  '基准', '评测', '开源模型',
]

export const NEGATIVE = [
  '手机', '笔记本', '轻薄本', '台式机', '平板', '显示器', '耳机', '音箱',
  '电视', '空调', '冰箱', '洗衣机', '路由', '主板', '显卡', '机械键盘', '鼠标',
  '移动电源', '充电', 'NAS', '主机', '上架', '开箱', '评测', '跑分', '预约',
  '售价', '促销', '双十一', '国补', '京东', '淘宝', '拼多多',
  '电影', '电视剧', '综艺', '游戏', '驱动',
]

/**
 * 非 AI 主体：这些是技术产品/框架，本身不是 AI。
 * 标题里出现它们、又没有「模型 / 智能体 / 融资收购」这类词时，判定为"AI 只是配角"。
 * 例：PostgreSQL 19 发布推迟——只是正文里提到"AI 找茬快"，不是 AI 新闻。
 */
export const DENY_SUBJECT = [
  'PostgreSQL', 'MySQL', 'Redis', 'MongoDB', 'Kubernetes', 'Docker',
  'React', 'Vue', 'Angular', 'Node.js', 'Spring', 'JDK', 'Rust', 'Kotlin',
  'GitLab', 'Xcode', 'Linux', 'Ubuntu', 'Windows', 'Android',
]

export function decodeEntities(s) {
  const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return s
    .replace(/&([a-z]+);/gi, (m, k) => map[k.toLowerCase()] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
}

export function stripTags(s) {
  return decodeEntities(String(s).replace(/<!\[CDATA\[|\]\]>/g, ''))
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'))
  return m ? m[1] : ''
}

export function parseFeed(xml, feed) {
  const blocks = xml.split(/<(?:item|entry)[\s>]/).slice(1)
  const items = []
  for (const block of blocks) {
    const title = stripTags(tag(block, 'title'))
    let link = stripTags(tag(block, 'link'))
    if (!link) {
      const m = block.match(/<link[^>]*href=["']([^"']+)["']/i)
      link = m ? decodeEntities(m[1]) : ''
    }
    const dateRaw = stripTags(tag(block, 'pubDate')) || stripTags(tag(block, 'published')) || stripTags(tag(block, 'updated'))
    let desc = stripTags(tag(block, 'description')) || stripTags(tag(block, 'summary')) || stripTags(tag(block, 'content'))
    desc = desc.replace(/^Article URL:\s*\S+\s*/i, '').replace(/Comments URL:\s*\S+\s*$/i, '').trim()
    if (desc.length < 20) desc = '' // InfoQ 的 "点击查看原文>" 之类
    const ts = Date.parse(dateRaw)
    if (!title || !link || !Number.isFinite(ts)) continue
    items.push({ feed, title, link, ts, desc })
  }
  return items
}

export async function fetchFeed(feed, timeoutMs = 15000) {
  const url = feed.url
  const opts = {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; dsh-brief/0.1)' },
    signal: AbortSignal.timeout(timeoutMs),
  }
  let lastErr
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, opts)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.text()
    } catch (e) {
      lastErr = e
      if (attempt === 0) await new Promise(r => setTimeout(r, 800))
    }
  }
  throw lastErr
}

/** 英文词按词边界匹配：`AI` 不能命中 Air。 */
export function hits(text, words) {
  return words.filter(w => {
    if (/^[\x00-\x7F]+$/.test(w)) {
      const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(`(^|[^a-zA-Z0-9])${esc}([^a-zA-Z0-9]|$)`, 'i').test(text)
    }
    return text.includes(w)
  })
}

export function classify(title) {
  if (/融资|收购|估值|IPO|上市|领投|轮融资/.test(title)) return '融资收购'
  if (/政策|监管|法规|合规|备案|出口管制|立法|版权|诉讼/.test(title)) return '政策监管'
  if (/论文|研究|数据集|基准|榜单|SOTA/.test(title)) return '研究'
  if (/开源|GitHub|权重|仓库/.test(title)) return '开源'
  if (/机器人|具身|自动驾驶/.test(title)) return '具身智能'
  if (/发布|上线|推出|开放|更新|升级/.test(title)) return '产品发布'
  return '行业'
}

export function score(item, now) {
  const strong = hits(item.title, STRONG)
  const weak = hits(item.title, WEAK)
  const neg = hits(item.title, NEGATIVE)
  if (neg.length > 0) return null
  if (strong.length === 0 && weak.length < 2) return null

  // 「AI 只是配角」：主体是别的技术产品，且标题里没有资本动作 → 丢弃。
  // 注意：像「Xcode 推出对智能体友好的配置格式」这种，AI 仍然只是配角，一并丢掉。
  const denySubject = hits(item.title, DENY_SUBJECT)
  if (denySubject.length > 0 && !/融资|收购|估值|IPO|大模型|发布.{0,6}模型/.test(item.title)) return null

  let s = 1 + item.feed.weight
  s += Math.min(strong.length * 2, 6)
  s += Math.min(weak.length, 3) * 0.5
  if (/[0-9][\d,.]*\s*(亿|万|百万|千万|美元|亿元|亿美金)/.test(item.title)) s += 2
  if (/\d/.test(item.title)) s += 0.5

  const ageH = (now - item.ts) / 3600e3
  s += ageH <= 6 ? 2 : ageH <= 12 ? 1 : ageH <= 24 ? 0.5 : 0

  return { ...item, score: Number(s.toFixed(2)), strong, weak, category: classify(item.title), ageH }
}

/**
 * 按来源配额挑选候选。
 *
 * 不这么做的话，候选池里占比高的源（InfoQ）会把名额吃光，
 * 结果 10 条里 6 条来自同一家，视角严重偏斜。
 *
 * 配额是「软上限」：先按上限挑一轮，不够再按分数补齐。
 * 否则一旦某几个源抓取失败，候选会少到凑不满。
 */
export function selectWithQuota(items, { perSource = 3, total = 18 } = {}) {
  const used = new Map()
  const picked = []
  const seen = new Set()

  for (const it of items) {
    if (picked.length >= total) break
    const n = used.get(it.feed.id) ?? 0
    if (n >= perSource) continue
    used.set(it.feed.id, n + 1)
    picked.push(it)
    seen.add(it)
  }

  // 补齐：仍然按分数顺序，只是不再受配额限制
  for (const it of items) {
    if (picked.length >= total) break
    if (seen.has(it)) continue
    picked.push(it)
    seen.add(it)
  }

  return picked
}

function fingerprint(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'its', 'will', 'now', 'says', 'into', 'over', 'after', 'about', 'has', 'have', 'are', 'was', 'not', 'but', 'can', 'how', 'why', 'new'])

/** 英文标题的实词集合，用来判断"是不是同一件事"。 */
function tokens(title) {
  return new Set(
    title.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)),
  )
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const w of a) if (b.has(w)) inter++
  return inter / (a.size + b.size - inter)
}

/**
 * 去重，两层：
 *   1. 中文按字符串包含（短标题被长标题包含且长度接近）
 *   2. 英文按实词 Jaccard ≥ 0.5
 * 第二层是为了合并"同一事件、不同媒体、措辞不同"的报道，
 * 比如 TechCrunch 和 The Verge 都在写 OpenAI 不用互联网训练。
 */
export function dedupe(items) {
  const out = []
  const seenUrl = new Set()
  const outTokens = []

  for (const it of items) {
    let url
    try {
      const u = new URL(it.link)
      url = u.host + u.pathname.replace(/\/$/, '')
    } catch { url = it.link }
    if (seenUrl.has(url)) continue

    const fp = fingerprint(it.title)
    const tk = tokens(it.title)

    const dup = out.find((o, i) => {
      const of = fingerprint(o.title)
      if (of === fp) return true
      const [a, b] = of.length < fp.length ? [of, fp] : [fp, of]
      if (a.length >= 10 && b.includes(a) && a.length / b.length > 0.7) return true
      return jaccard(tk, outTokens[i]) >= 0.5
    })
    if (dup) continue

    seenUrl.add(url)
    out.push(it)
    outTokens.push(tk)
  }
  return out
}

/**
 * 一次完整采集。
 * @returns {Promise<{items: object[], stats: {raw: number, inWindow: number, relevant: number, deduped: number, feeds: string[]}}>}
 */
export async function collect({ hours = 30, now = Date.now() } = {}) {
  const since = now - hours * 3600e3
  const all = []
  const feedStats = []
  for (const feed of FEEDS) {
    try {
      const items = parseFeed(await fetchFeed(feed), feed)
      feedStats.push(`${feed.name}:${items.length}`)
      all.push(...items)
    } catch (e) {
      feedStats.push(`${feed.name}:✗`)
    }
  }
  const inWindow = all.filter(i => i.ts >= since && i.ts <= now + 3600e3)
  const scored = inWindow.map(i => score(i, now)).filter(Boolean).sort((a, b) => b.score - a.score)
  const deduped = dedupe(scored)
  return {
    items: deduped,
    stats: { raw: all.length, inWindow: inWindow.length, relevant: scored.length, deduped: deduped.length, feeds: feedStats },
  }
}
