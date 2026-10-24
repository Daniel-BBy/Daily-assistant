#!/usr/bin/env node
/**
 * 课表 CLI：只做"读文件 + 打印"，业务逻辑全在 courses.js 里。
 * 单独拆出来是为了让 courses.js 能被浏览器直接 import（不含 node: 依赖）。
 */

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadSchedule, resolveDate, coursesOn, nextTeachingDay, renderCourses,
  todayInZone, weekdayIndex, DAY_NAMES, campusOf,
} from './courses.js'

const HERE = dirname(fileURLToPath(import.meta.url))
// --- CLI：单独预览 ---

async function main() {
  const args = process.argv.slice(2)
  let date = null
  let json = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date') date = args[++i]
    else if (args[i] === '--json') json = true
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log('node scripts/courses-cli.js [--date YYYY-MM-DD] [--json]')
      return 0
    } else throw new Error(`未知参数：${args[i]}`)
  }

  const termData = JSON.parse(await readFile(resolve(HERE, '..', 'data', 'term.json'), 'utf8'))
  const rows = loadSchedule(await readFile(resolve(HERE, '..', 'course_schedule.csv'), 'utf8'))
  const timezone = termData.timezone ?? 'Asia/Shanghai'
  const day = date ?? todayInZone(timezone)

  const resolution = resolveDate(termData, day)
  const courses = resolution.status === 'teaching'
    ? coursesOn(rows, weekdayIndex(day), resolution.week)
    : []
  const next = nextTeachingDay(rows, termData, day)

  if (json) {
    console.log(JSON.stringify({
      date: day,
      weekday: DAY_NAMES[weekdayIndex(day)],
      status: resolution.status,
      week: resolution.week ?? null,
      label: resolution.label ?? null,
      courses: courses.map(c => ({ time: c.timeText, course: c.course, room: c.room, campus: campusOf(c.room) })),
      next: next ? { date: next.date, week: next.week, courses: next.courses.map(c => c.course) } : null,
    }, null, 2))
    return 0
  }

  console.log(renderCourses({ date: day, resolution, courses, next }))
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
    .then(code => { process.exitCode = code })
    .catch(error => { console.error(`[courses] ${error.message}`); process.exitCode = 1 })
}
