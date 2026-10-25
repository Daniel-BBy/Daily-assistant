#!/usr/bin/env node
/**
 * 每日 AI 新闻早报：采集 → 取正文 → LLM 选 10 条 + 写摘要 → data/news.json
 *
 * 核心约束（防幻觉）：模型只能从给定编号里选，不许新增事实。
 * 出处（来源、链接、时间）全部由脚本回填，不经过模型。
 *
 * 用法：
 *   node scripts/news.js                  # 默认最近 24h，出 10 条
 *   node scripts/news.js --hours 36 --limit 8 --dry
 *   node scripts/news.js --out data/news.json
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collect, selectWithQuota } from './news-sources.js'
import { fetchPage, extractMain, lead } from './news-article.js'
import { chat } from './news-llm.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const CATEGORIES = ['融资收购', '产品发布', '政策监管', '开源', '研究', '具身智能', '行业']

function parseArgs(argv) {
  const out = { hours: 24, limit: 10, dry: false, force: false, dir: join(ROOT, 'data', 'news'), candidates: 18, perSource: 3 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--hours') out.hours = Number(argv[++i])
    else if (a === '--limit') out.limit = Number(argv[++i])
    else if (a === '--candidates') out.candidates = Number(argv[++i])
    else if (a === '--per-source') out.perSource = Number(argv[++i])
    else if (a === '--dir') out.dir = resolve(argv[++i])
    else if (a === '--dry') out.dry = true
    else if (a === '--force') out.force = true
    else if (a === '--help' || a === '-h') out.help = true
    else throw new Error(`未知参数：${a}`)
  }
  return out
}

/** 北京时间今天（YYYY-MM-DD）。cron 跑在 UTC，日期必须按北京算。 */
function todayBeijing() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
}

/**
 * 维护往期索引。
 *
 * 静态站不能列目录，浏览器没法"看看这个文件夹里有什么"，
 * 必须有一份显式清单告诉前端存在哪些期。
 */
async function updateIndex(dir, entry) {
  const { readFile } = await import('node:fs/promises')
  let index = { days: [] }
  try {
    index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'))
  } catch { /* 第一期：从零开始建 */ }

  const days = (index.days ?? []).filter(d => d.date !== entry.date)
  days.push(entry)
  days.sort((a, b) => (a.date < b.date ? 1 : -1))   // 新的在前

  const next = { updatedAt: new Date().toISOString(), latest: days[0].date, days }
  await writeFile(join(dir, 'index.json'), JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

function buildPrompt(items, limit) {
  const list = items.map((it, i) => {
    const body = (it.body || it.desc || '').slice(0, 400)
    return [
      `[${i + 1}] 来源：${it.feed.name}｜${it.title}`,
      body ? `正文开头：${body}` : '正文开头：（无）',
    ].join('\n')
  }).join('\n\n')

  const system = [
    '你是中文科技媒体的早报编辑。',
    '你的唯一职责是「挑选」和「压缩」：从给定候选里选出最重要的几条，并写出摘要。',
    '你不得引入候选之外的事实、数字、人名、公司名或时间。',
    '你不得猜测、不得评价、不得补充背景。',
  ].join('\n')

  const user = `下面是过去一段时间抓到的 AI 相关新闻候选，共 ${items.length} 条。

${list}

请按要求挑选并输出 JSON：

1. 最多选 ${limit} 条，宁缺毋滥；候选不够重要就少选。
2. 按重要性从高到低排序（影响面大、大公司、大金额、新技术优先）。
3. 同一事件被多家报道时只选一条，选信息量最大的。
4. 【重要】AI 必须是这条新闻的主角。如果 AI 只是顺带被提到（例如某数据库/框架发版，正文里说"AI 修 bug 快"），不要选它。
5. 每条给出：
   - index：候选编号（数字）
   - category：只能是下面 7 个之一
   - title：中文标题，不超过 30 字，用陈述句，不加感叹号
   - summary：两句话，60–90 字，只复述正文里出现的信息
6. 输出格式：{"items":[{"index":1,"category":"...","title":"...","summary":"..."}]}

category 定义（严格按此判断）：
- 融资收购：融资、并购、估值、IPO、投资、股权交易
- 产品发布：新模型 / 新工具 / 新功能 / 新版本正式上线
- 政策监管：政府、法院、法规、版权、合规、出口管制、诉讼
- 开源：模型权重或代码开源、标准捐赠、基金会治理
- 研究：论文、数据集、基准测试、实验结果
- 具身智能：机器人、自动驾驶、与物理世界交互的硬件系统
- 行业：公司战略、人事、合作、市场格局（以上都不完全属于时用这个）

再次强调：summary 里的每个事实都必须能在对应候选的正文开头里找到。`

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

function validate(parsed, items) {
  if (!parsed || !Array.isArray(parsed.items)) throw new Error('模型返回的 JSON 里没有 items 数组')
  const seen = new Set()
  const out = []
  for (const raw of parsed.items) {
    const idx = Number(raw?.index)
    if (!Number.isInteger(idx) || idx < 1 || idx > items.length) continue
    if (seen.has(idx)) continue
    seen.add(idx)
    const src = items[idx - 1]
    const category = CATEGORIES.includes(raw?.category) ? raw.category : src.category
    out.push({
      category,
      title: String(raw?.title ?? src.title).slice(0, 60),
      summary: String(raw?.summary ?? '').slice(0, 200),
      source: src.feed.name,
      sourceId: src.feed.id,
      url: src.link,
      publishedAt: new Date(src.ts).toISOString(),
      // 溯源：保留原始标题与打分，便于日后核对模型有没有编
      originalTitle: src.title,
      score: src.score,
      bodyMethod: src.bodyMethod ?? null,
    })
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('node scripts/news.js [--hours 24] [--limit 10] [--candidates 18] [--dir data/news] [--dry] [--force]')
    return 0
  }

  // 幂等：今天已经生成过就跳过。
  // cron 设了两个时间点（主跑 + 兜底），兜底那次必须秒退，不能重复花 LLM 的钱。
  const today = todayBeijing()
  const issueFile = join(args.dir, `${today}.json`)
  if (!args.force) {
    const { existsSync } = await import('node:fs')
    if (existsSync(issueFile)) {
      console.log(`已有 ${today} 的早报（${issueFile}），跳过。要重跑加 --force。`)
      return 0
    }
  }

  console.log(`\n① 采集（最近 ${args.hours} 小时）`)
  const { items, stats } = await collect({ hours: args.hours })
  console.log(`   ${stats.feeds.join('  ')}`)
  console.log(`   原始 ${stats.raw} → 窗口内 ${stats.inWindow} → AI 相关 ${stats.relevant} → 去重后 ${stats.deduped}`)

  if (items.length === 0) {
    console.log('没有候选，退出。')
    return 0
  }

  const picked = selectWithQuota(items, { perSource: args.perSource, total: args.candidates })
  const quotaInfo = Object.entries(picked.reduce((a, x) => (a[x.feed.name] = (a[x.feed.name] || 0) + 1, a), {}))
    .map(([k, v]) => `${k}=${v}`).join('  ')
  console.log(`   配额挑选（每源 ≤${args.perSource}，共 ${picked.length} 条）：${quotaInfo}`)

  console.log(`\n② 取正文（${picked.length} 条）`)
  let fetched = 0
  for (const it of picked) {
    if ((it.desc || '').length >= 400) {
      it.body = it.desc
      it.bodyMethod = 'rss'
      continue
    }
    try {
      const html = await fetchPage(it.link)
      const { text, method } = extractMain(html)
      it.body = lead(text, 600)
      it.bodyMethod = method
      if (method !== 'empty') fetched++
    } catch (e) {
      it.body = it.desc || ''
      it.bodyMethod = 'failed'
    }
  }
  console.log(`   抓取成功 ${fetched} / ${picked.filter(i => i.bodyMethod !== 'rss').length}`)

  console.log(`\n③ 让模型挑 ${args.limit} 条并写摘要`)
  const messages = buildPrompt(picked, args.limit)
  const { content, usage } = await chat({ messages, json: true, maxTokens: 2200, temperature: 0.2 })

  let parsed
  try { parsed = JSON.parse(content) } catch (e) {
    console.error('模型返回的不是合法 JSON：\n' + content.slice(0, 500))
    return 1
  }

  const news = validate(parsed, picked)
  console.log(`   选出 ${news.length} 条 · 用量 ${usage.prompt_tokens ?? '?'} in / ${usage.completion_tokens ?? '?'} out`)

  // 失败保护：宁可显示昨天的，也不要覆盖成空白页。
  // 返回 0 让后续的构建/部署继续跑，页面上仍然是上一期的内容。
  if (news.length < 5) {
    console.error(`只选出 ${news.length} 条（少于 5），保留上一期，不写入 ${args.dir}`)
    return 0
  }

  if (!args.dry) {
    await mkdir(args.dir, { recursive: true })
    await writeFile(issueFile, JSON.stringify({
      generatedAt: new Date().toISOString(),
      date: today,
      stats,
      usage,
      items: news,
    }, null, 2) + '\n', 'utf8')

    const index = await updateIndex(args.dir, {
      date: today,
      count: news.length,
      top: news[0].title,
    })
    console.log(`\n④ 已写入 ${issueFile}`)
    console.log(`   索引现有 ${index.days.length} 期：${index.days.map(d => d.date).join(', ')}`)
  }

  console.log('\n================ 早报预览 ================\n')
  news.forEach((n, i) => {
    console.log(`${String(i + 1).padStart(2, '0')} ［${n.category}］${n.title}`)
    console.log(`    ${n.summary}`)
    console.log(`    来源：${n.source}  ${n.url}`)
    console.log()
  })

  return 0
}

main()
  .then(code => { process.exitCode = code })
  .catch(e => { console.error(`[news] ${e.message}`); process.exitCode = 1 })
