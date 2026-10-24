#!/usr/bin/env node
/**
 * 每日简报 CLI：天气（Open-Meteo 增强版 + 自算风险）+ 今日课程。
 *
 * 用法：
 *   node scripts/brief.js                 # 打印到 stdout
 *   node scripts/brief.js --json          # 结构化 JSON
 *   node scripts/brief.js --config X.json # 指定配置
 *   node scripts/brief.js --webhook       # 按配置 POST 到 webhook
 *   node scripts/brief.js --date 2026-10-27   # 指定日期（调试用）
 *
 * 退出码：0 成功；2 天气获取失败（已输出降级文本）；1 配置/参数错误。
 */

import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchForecast, normalize } from './openmeteo.js'
import { evaluate, weatherText } from './risks.js'
import { renderBrief } from './render.js'
import {
  loadSchedule, resolveDate, coursesOn, nextTeachingDay, renderCourses,
  todayInZone, weekdayIndex, DAY_NAMES, campusOf,
} from './courses.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const DEFAULT_CONFIG = join(ROOT, 'data', 'brief.config.json')

function parseArgs(argv) {
  const args = { config: DEFAULT_CONFIG, json: false, webhook: false, date: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') args.json = true
    else if (a === '--webhook') args.webhook = true
    else if (a === '--date') args.date = argv[++i]
    else if (a === '--config') args.config = resolve(argv[++i] ?? '')
    else if (a === '--help' || a === '-h') args.help = true
    else throw new Error(`未知参数：${a}`)
  }
  return args
}

async function loadConfig(path) {
  const cfg = JSON.parse(await readFile(path, 'utf8'))
  if (!cfg.place?.latitude || !cfg.place?.longitude) throw new Error('配置缺少 place.latitude / place.longitude')
  if (!cfg.thresholds) throw new Error('配置缺少 thresholds')
  return cfg
}

/** 目的地时区的当前分钟数（用于给已结束的课打标）。 */
function nowMinutesInZone(timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date())
  const get = t => Number(parts.find(p => p.type === t)?.value ?? 0)
  return get('hour') * 60 + get('minute')
}

/** 读课表与周次表；缺失时返回 null，让简报其余部分照常输出。 */
async function loadCourses(cfg) {
  try {
    const termPath = resolve(ROOT, cfg.paths?.term ?? 'data/term.json')
    const schedulePath = resolve(ROOT, cfg.paths?.schedule ?? 'course_schedule.csv')
    const termData = JSON.parse(await readFile(termPath, 'utf8'))
    const rows = loadSchedule(await readFile(schedulePath, 'utf8'))
    return { termData, rows }
  } catch (error) {
    console.error(`[brief] 课表不可用：${error.message}`)
    return null
  }
}

function buildCourses(schedule, date, timezone) {
  if (!schedule) return null
  const { termData, rows } = schedule
  const resolution = resolveDate(termData, date)
  const courses = resolution.status === 'teaching'
    ? coursesOn(rows, weekdayIndex(date), resolution.week)
    : []
  const next = nextTeachingDay(rows, termData, date)
  const text = renderCourses({
    date, resolution, courses, next,
    nowMinutes: nowMinutesInZone(timezone),
  })
  return {
    text,
    json: {
      status: resolution.status,
      week: resolution.week ?? null,
      label: resolution.label ?? null,
      weekday: DAY_NAMES[weekdayIndex(date)],
      list: courses.map(c => ({
        time: c.timeText, course: c.course, room: c.room, campus: campusOf(c.room),
      })),
      next: next ? { date: next.date, week: next.week, time: next.courses[0].timeText, course: next.courses[0].course } : null,
    },
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('node scripts/brief.js [--json] [--webhook] [--config <path>] [--date YYYY-MM-DD]')
    return 0
  }

  const cfg = await loadConfig(args.config)
  const timezone = cfg.place.timezone ?? 'Asia/Shanghai'
  const date = args.date ?? todayInZone(timezone)
  const window = cfg.morningWindow ?? { startHour: 6, endHour: 10 }

  const schedule = await loadCourses(cfg)
  const courses = buildCourses(schedule, date, timezone)

  let data
  let degraded
  try {
    const json = await fetchForecast(cfg.place, { timeoutMs: 15000, retries: 2 })
    data = normalize(json)
  } catch (error) {
    degraded = error.message
  }

  const today = data?.days?.[0] ?? { date }

  if (degraded) {
    const text = renderBrief({
      place: cfg.place, day: { date }, derived: {}, items: [],
      thresholds: cfg.thresholds, degraded,
      courses: courses?.text ?? null,
    })
    emit(text, args, cfg)
    console.error(`[brief] 降级输出：${degraded}`)
    return 2
  }

  const { items, derived } = evaluate(data, cfg.thresholds, window)
  const text = renderBrief({
    place: cfg.place, day: today, derived, items,
    thresholds: cfg.thresholds,
    weatherText: weatherText(today.weatherCode),
    courses: courses?.text ?? null,
  })

  if (args.json) {
    console.log(JSON.stringify({
      ok: true,
      date,
      place: cfg.place,
      weather: { derived, items },
      courses: courses?.json ?? null,
      text,
      source: 'open-meteo',
      alerts: { official: false, reason: '未接入官方预警源' },
    }, null, 2))
  } else {
    emit(text, args, cfg)
  }
  return 0
}

/** 按配置投递；webhook 失败只告警，不影响 stdout 已经给出的内容。 */
function emit(text, args, cfg) {
  console.log(text)
  const useWebhook = args.webhook || (cfg.delivery?.mode === 'webhook')
  const url = cfg.delivery?.webhook?.url
  if (!useWebhook || !url) return
  const timeoutMs = cfg.delivery?.webhook?.timeoutMs ?? 5000
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: `${cfg.place.name} 今日简报`, text }),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(error => {
    console.error(`[brief] webhook 投递失败：${error.message}`)
  })
}

main()
  .then(code => { process.exitCode = code })
  .catch(error => {
    console.error(`[brief] ${error.message}`)
    process.exitCode = 1
  })
