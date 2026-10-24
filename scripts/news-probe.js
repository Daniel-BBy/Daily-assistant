#!/usr/bin/env node
/**
 * 新闻采集探针（prototype，不是最终版）
 *
 * 目的只有一个：把"抓取 → 时间窗 → AI 相关性 → 去重 → 打分"跑通，
 * 把候选打出来，判断两件事：
 *   1. 候选质量够不够（垃圾候选，接 LLM 也救不回来）
 *   2. 数量够不够挑 10 条
 *
 * 还没做的：摘要生成、分类精修、页面渲染、定时。
 *
 * 用法：
 *   node scripts/news-probe.js [--hours 30] [--top 20] [--all]
 */

const FEEDS = [
  { id: 'ithome', name: 'IT之家', url: 'https://www.ithome.com/rss/', weight: 1.0, hasBody: true },
  { id: 'qbitai', name: '量子位', url: 'https://www.qbitai.com/feed', weight: 2.0 },
  { id: 'infoq', name: 'InfoQ中文', url: 'https://www.infoq.cn/feed', weight: 1.0 },
  { id: 'sina', name: '新浪科技', url: 'https://rss.sina.com.cn/tech/rollnews.xml', weight: 0.8 },
  { id: 'tc', name: 'TechCrunch', url: 'https://techcrunch.com/category/artificial-intelligence/feed/', weight: 1.6 },
  { id: 'verge', name: 'The Verge', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', weight: 1.4 },
  { id: 'hn', name: 'Hacker News', url: 'https://hnrss.org/frontpage', weight: 1.2 },
]

/** 强 AI 信号：出现在标题里基本可以认定是 AI 新闻。 */
const STRONG = [
  'AI', '人工智能', '大模型', '大语言模型', 'LLM', 'GPT', 'ChatGPT', 'Sora',
  'OpenAI', 'Anthropic', 'Claude', 'Gemini', 'DeepMind', 'DeepSeek', 'Kimi',
  '月之暗面', '通义', '文心', '豆包', '混元', '智谱', 'MiniMax', 'Mistral',
  '智能体', 'Agent', '具身智能', '人形机器人', '机器人', '算力', '英伟达',
  'NVIDIA', 'H100', 'B200', 'GB200', 'TPU', '推理模型', '多模态', 'RAG', 'MCP',
  'Transformer', '扩散模型', '神经网络', '机器学习', '深度学习',
]

/** 弱信号：命中两个以上才算 ai-adjacent。 */
const WEAK = [
  '融资', '收购', '估值', 'IPO', '发布', '上线', '推出', '开源', '芯片',
  '数据中心', '自动驾驶', '监管', '政策', '合规', '研究', '论文', '数据集',
  '基准', '评测', '开源模型',
]

/** 排除词：命中即丢弃。IT之家 是全品类源，消费电子占了大多数。 */
const NEGATIVE = [
  '手机', '笔记本', '轻薄本', '台式机', '平板', '显示器', '耳机', '音箱',
  '电视', '空调', '冰箱', '洗衣机', '路由', '主板', '显卡', '机械键盘', '鼠标',
  '移动电源', '充电', 'NAS', '主机', '上架', '开箱', '评测', '跑分', '预约',
  '售价', '促销', '双十一', '国补', '京东', '淘宝', '拼多多',
  '电影', '电视剧', '综艺', '游戏', '驱动',
]

function parseArgs(argv) {
  const out = { hours: 30, top: 20, all: false, bodies: 10 }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--hours') out.hours = Number(argv[++i])
    else if (argv[i] === '--top') out.top = Number(argv[++i])
    else if (argv[i] === '--bodies') out.bodies = Number(argv[++i])
    else if (argv[i] === '--all') out.all = true
  }
  return out
}

// --- 极简 XML 抽取（feed 场景够用，不处理任意 XML）---

function decodeEntities(s) {
  const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return s
    .replace(/&([a-z]+);/gi, (m, k) => map[k.toLowerCase()] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<!\[CDATA\[|\]\]>/g, ''))
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'))
  return m ? m[1] : ''
}

function parseFeed(xml, feed) {
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
    // HN 的 description 是 "Article URL: …  Comments URL: …"，去掉这层壳
    desc = desc.replace(/^Article URL:\s*\S+\s*/i, '').replace(/Comments URL:\s*\S+\s*$/i, '').trim()
    // InfoQ 的 description 只有 "点击查看原文>"，当没有摘要处理
    if (desc.length < 20) desc = ''
    const ts = Date.parse(dateRaw)
    if (!title || !link || !Number.isFinite(ts)) continue
    items.push({ feed, title, link, ts, desc })
  }
  return items
}

// --- 打分 ---

/**
 * 关键词命中。
 *
 * 英文词必须按「词边界」匹配：`AI` 用 includes 会命中 Air / chair / Email，
 * 这是第一版把「惠普星 Book Air」判成 AI 新闻的原因。
 */
function hits(text, words) {
  return words.filter(w => {
    if (/^[\x00-\x7F]+$/.test(w)) {
      const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(`(^|[^a-zA-Z0-9])${esc}([^a-zA-Z0-9]|$)`, 'i').test(text)
    }
    return text.includes(w)
  })
}

function classify(title) {
  const t = title
  if (/融资|收购|估值|IPO|上市|领投|轮融资/.test(t)) return '融资收购'
  if (/政策|监管|法规|合规|备案|出口管制|立法/.test(t)) return '政策监管'
  if (/论文|研究|数据集|基准|榜单|SOTA/.test(t)) return '研究'
  if (/开源|GitHub|权重|仓库/.test(t)) return '开源'
  if (/发布|上线|推出|开放|更新|升级/.test(t)) return '产品发布'
  if (/机器人|具身|自动驾驶|车/.test(t)) return '具身智能'
  return '行业'
}

function score(item, now) {
  const strong = hits(item.title, STRONG)
  const weak = hits(item.title, WEAK)
  const neg = hits(item.title, NEGATIVE)

  // 排除词一票否决：只要标题里出现消费电子/影视/驱动这类词，就不算 AI 新闻。
  // 之前允许「有强信号就保留」，结果英伟达驱动 Bug、Book Air 全混进来了。
  if (neg.length > 0) return null
  if (strong.length === 0 && weak.length < 2) return null

  let s = 1 + item.feed.weight
  s += Math.min(strong.length * 2, 6)
  s += Math.min(weak.length, 3) * 0.5
  if (/[0-9][\d,.]*\s*(亿|万|百万|千万|美元|亿元|亿美金)/.test(item.title)) s += 2
  if (/\d/.test(item.title)) s += 0.5

  const ageH = (now - item.ts) / 3600e3
  s += ageH <= 6 ? 2 : ageH <= 12 ? 1 : ageH <= 24 ? 0.5 : 0

  return { ...item, score: Number(s.toFixed(2)), strong, weak, neg, category: classify(item.title), ageH }
}

function fingerprint(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function dedupe(items) {
  const out = []
  const seenUrl = new Set()
  for (const it of items) {
    let url
    try {
      const u = new URL(it.link)
      url = u.host + u.pathname.replace(/\/$/, '')
    } catch { url = it.link }
    if (seenUrl.has(url)) continue
    const fp = fingerprint(it.title)
    const dup = out.find(o => {
      const of = fingerprint(o.title)
      if (of === fp) return true
      // 粗略相似：较短串包含于较长串，且长度差不大
      const [a, b] = of.length < fp.length ? [of, fp] : [fp, of]
      return a.length >= 10 && b.includes(a) && a.length / b.length > 0.7
    })
    if (dup) continue
    seenUrl.add(url)
    out.push(it)
  }
  return out
}

async function fetchFeed(feed) {
  const res = await fetch(feed.url, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; dsh-brief-probe/0.1)' },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

/**
 * 抓正文。用 arrayBuffer + 编码探测：中文站有不少是 GBK，
 * 直接 .text() 会得到一堆乱码，而乱码喂给模型 = 灾难。
 */
async function fetchArticleText(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; dsh-brief-probe/0.1)' },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())

  let text = buf.toString('utf8')
  const bad = (text.match(/\uFFFD/g) || []).length
  if (bad > 20) {
    try { text = new TextDecoder('gbk').decode(buf) } catch { /* 保持 utf8 结果 */ }
  }

  // 去掉脚本/样式，只留正文文本
  const body = text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
  return stripTags(body)
}

/** 从正文里截一段"像开头"的内容，用于给模型当素材。 */
function leadParagraph(text, limit = 400) {
  const clean = text.replace(/\s+/g, ' ').trim()
  // 尽量从第一个像正文的位置开始，跳过导航残留
  const start = clean.search(/[。！？!?]/) > 0 ? 0 : 0
  return clean.slice(start, start + limit)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const now = Date.now()
  const since = now - args.hours * 3600e3

  console.log(`\n抓取窗口：最近 ${args.hours} 小时（${new Date(since).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} 起）\n`)

  const all = []
  const stats = []
  for (const feed of FEEDS) {
    try {
      const xml = await fetchFeed(feed)
      const items = parseFeed(xml, feed)
      stats.push(`${feed.name}: ${items.length} 条`)
      all.push(...items)
    } catch (e) {
      stats.push(`${feed.name}: 失败（${e.message}）`)
    }
  }
  console.log('原始抓取 → ' + stats.join('  |  '))

  const inWindow = all.filter(i => i.ts >= since && i.ts <= now + 3600e3)
  console.log(`时间窗内 → ${inWindow.length} 条`)

  const scored = inWindow.map(i => score(i, now)).filter(Boolean)
  console.log(`AI 相关 → ${scored.length} 条`)

  const deduped = dedupe(scored.sort((a, b) => b.score - a.score))
  console.log(`去重后 → ${deduped.length} 条\n`)

  // ① 候选池全貌
  console.log(`\n===== 候选池（${deduped.length} 条，按分数排序）=====\n`)
  deduped.slice(0, 40).forEach((it, i) => {
    const t = new Date(it.ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    console.log(`${String(i + 1).padStart(2, '0')} [${String(it.score).padStart(4)}] ${it.category.padEnd(4)} ${it.feed.name.padEnd(12)} ${t}  ${it.title}`)
  })

  // ② 抓正文：只抓前 N 条里「RSS 没带正文」的那些
  const topN = Math.min(args.bodies, deduped.length)
  const targets = deduped.slice(0, topN).filter(it => (it.desc || '').length < 200)
  console.log(`\n===== 正文抓取：前 ${topN} 条中需要抓 ${targets.length} 条 =====\n`)

  let bodyOk = 0
  for (const it of targets) {
    try {
      const text = await fetchArticleText(it.link)
      it.body = leadParagraph(text)
      if (text.length >= 200) bodyOk++
      console.log(`✓ ${it.feed.name}  正文 ${text.length} 字  ${it.title.slice(0, 36)}`)
      console.log(`   ${it.body.slice(0, 110)}…`)
      console.log()
    } catch (e) {
      console.log(`✗ ${it.feed.name}  ${e.message.slice(0, 30)}  ${it.title.slice(0, 36)}`)
    }
  }

  // ③ 结论：够不够喂模型
  const pool = deduped.slice(0, Math.max(topN, 10))
  const usable = pool.filter(it => ((it.body || it.desc) || '').length >= 150).length
  console.log(`\n===== 统计 =====`)
  console.log(`候选池 ${deduped.length} 条；检查前 ${pool.length} 条，可用素材 ≥150 字的 ${usable} 条`)
  const byCat = {}
  const byFeed = {}
  for (const it of deduped) { byCat[it.category] = (byCat[it.category] || 0) + 1; byFeed[it.feed.name] = (byFeed[it.feed.name] || 0) + 1 }
  console.log('分类：' + Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  '))
  console.log('来源：' + Object.entries(byFeed).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  '))
}

main().catch(e => { console.error(e); process.exitCode = 1 })
