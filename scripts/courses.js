/**
 * 课表模块：把 CSV 课表 + 校历周次表，解析成"今天有什么课"。
 *
 * 三层，全部是纯函数（除最后读文件）：
 *   1. 解析：CSV → 行；"1-3, 4-5" → Set<number>；"09:00-12:50" → 分钟
 *   2. 定位：日期 → 学期块 → 第几周 / 是否上课 / 是否放假
 *   3. 渲染：过滤 → 排序 → 文本
 *
 * 关键设计：周次靠查表，不靠"开学日 + 7 天"推算。
 * 国庆那周不属于任何教学周，用公式算会从 10/5 起整体错位一周。
 */

export const DAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

// --- 日期工具（全部用 UTC 构造，避开宿主时区） ---

/** `YYYY-MM-DD` → 该日 0 点的 UTC 毫秒。 */
function utcMs(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

/** 周日=0 … 周六=6（与 Date.getUTCDay 一致）。 */
function utcDay(dateStr) {
  return new Date(utcMs(dateStr)).getUTCDay()
}

/** 周日=0 → 本周一=0 … 周日=6。 */
export function weekdayIndex(dateStr) {
  return (utcDay(dateStr) + 6) % 7
}

export function addDays(dateStr, n) {
  const d = new Date(utcMs(dateStr) + n * 86400000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/** 目的地时区的"今天"（不依赖宿主机器时区）。 */
export function todayInZone(timezone = 'Asia/Shanghai') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const get = t => parts.find(p => p.type === t)?.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

export function formatDate(dateStr) {
  const [, m, d] = dateStr.split('-')
  return `${m}-${d} ${DAY_NAMES[weekdayIndex(dateStr)]}`
}

// --- 解析 ---

/** 最小 CSV 解析：支持双引号包裹与 `""` 转义（Weeks 字段含逗号，必须走这条）。 */
export function parseCsv(text) {
  const src = text.replace(/^\uFEFF/, '')
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else field += ch
      continue
    }
    if (ch === '"') inQuotes = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (ch !== '\r') field += ch
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }

  return rows.filter(r => r.some(cell => cell.trim() !== ''))
}

/**
 * `"5, 11"` → {5,11}；`"1-3, 4-5"` → {1,2,3,4,5}；`"8-13"` → {8..13}。
 * 解析失败直接抛错——静默跳过会让某门课在几周里凭空消失，最难排查。
 */
export function parseWeeks(spec) {
  const weeks = new Set()
  const text = String(spec).trim()
  if (text === '') throw new Error('周次为空')

  for (const raw of text.split(',')) {
    const token = raw.trim()
    if (token === '') continue
    const range = token.match(/^(\d+)\s*-\s*(\d+)$/)
    if (range) {
      const from = Number(range[1])
      const to = Number(range[2])
      if (from > to) throw new Error(`周次区间倒置：${token}`)
      for (let w = from; w <= to; w++) weeks.add(validateWeek(w, token))
      continue
    }
    const single = token.match(/^\d+$/)
    if (!single) throw new Error(`无法解析周次：${token}`)
    weeks.add(validateWeek(Number(token), token))
  }
  if (weeks.size === 0) throw new Error(`周次解析结果为空：${text}`)
  return weeks
}

function validateWeek(w, token) {
  if (!Number.isInteger(w) || w < 1 || w > 30) throw new Error(`周次越界（1–30）：${token}`)
  return w
}

/** `"09:00-12:50"` → {start: 540, end: 770}（自 0 点起的分钟数）。 */
export function parseTimeRange(text) {
  const m = String(text).trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/)
  if (!m) throw new Error(`无法解析时间：${text}`)
  const start = Number(m[1]) * 60 + Number(m[2])
  const end = Number(m[3]) * 60 + Number(m[4])
  if (end <= start) throw new Error(`时间区间无效：${text}`)
  return { start, end }
}

export function minutesToText(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
}

/**
 * CSV 文本 → 课程行。表头必须含 Day/Time/Course/Weeks/Room。
 * 任何一行出错都带上行号，不静默丢弃。
 */
export function loadSchedule(csvText) {
  const rows = parseCsv(csvText)
  if (rows.length === 0) throw new Error('课表为空')
  const header = rows[0].map(h => h.trim())
  const idx = name => {
    const i = header.indexOf(name)
    if (i < 0) throw new Error(`课表缺少列：${name}`)
    return i
  }
  const col = {
    day: idx('Day'), time: idx('Time'), course: idx('Course'),
    weeks: idx('Weeks'), room: idx('Room'),
  }
  const teacherCol = header.indexOf('Teacher')

  const out = []
  for (let r = 1; r < rows.length; r++) {
    const line = r + 1
    const cells = rows[r]
    const dayName = (cells[col.day] ?? '').trim()
    const dayIndex = DAY_NAMES.indexOf(dayName)
    if (dayIndex < 0) throw new Error(`第 ${line} 行：未知星期 "${dayName}"`)
    try {
      const time = parseTimeRange(cells[col.time] ?? '')
      out.push({
        line,
        dayIndex,
        dayName,
        time,
        timeText: `${minutesToText(time.start)}-${minutesToText(time.end)}`,
        course: (cells[col.course] ?? '').trim(),
        weeks: parseWeeks(cells[col.weeks] ?? ''),
        room: (cells[col.room] ?? '').trim(),
        teacher: teacherCol >= 0 ? (cells[teacherCol] ?? '').trim() : '',
      })
    } catch (error) {
      throw new Error(`第 ${line} 行：${error.message}`)
    }
  }
  if (out.length === 0) throw new Error('课表没有数据行')
  return out
}

// --- 定位今天 ---

/**
 * 日期 → 学期块。
 * @returns {{ status:'teaching', term, week, block } | { status:'off', term, block, label } | { status:'outside' }}
 */
export function resolveDate(termData, dateStr) {
  for (const term of termData.terms) {
    for (const block of term.blocks) {
      if (dateStr >= block.start && dateStr <= block.end) {
        if (!block.teaching) {
          return { status: 'off', term, block, label: block.label ?? block.kind, week: block.week }
        }
        const holiday = (term.holidays ?? []).find(h => h.date === dateStr)
        if (holiday) {
          return { status: 'holiday', term, block, week: block.week, label: holiday.label }
        }
        return { status: 'teaching', term, block, week: block.week }
      }
    }
  }
  return { status: 'outside' }
}

/** 某天某周次的课，按开始时间排序。 */
export function coursesOn(rows, dayIndex, week) {
  return rows
    .filter(r => r.dayIndex === dayIndex && r.weeks.has(week))
    .sort((a, b) => (a.time.start - b.time.start) || a.course.localeCompare(b.course))
}

/** 同一天里时间重叠的课对（数据里目前没有，但保留检测）。 */
export function findConflicts(courses) {
  const pairs = []
  for (let i = 0; i < courses.length; i++) {
    for (let j = i + 1; j < courses.length; j++) {
      const a = courses[i]
      const b = courses[j]
      if (a.time.start < b.time.end && b.time.start < a.time.end) pairs.push([a, b])
    }
  }
  return pairs
}

export function campusOf(room) {
  if (room.startsWith('SIP')) return '苏州校区'
  if (room.startsWith('TC')) return '太仓校区'
  return null
}

/** 往后找最近一次有课的日子（最多 21 天）。 */
export function nextTeachingDay(rows, termData, fromDate, maxDays = 21) {
  for (let i = 1; i <= maxDays; i++) {
    const date = addDays(fromDate, i)
    const hit = resolveDate(termData, date)
    if (hit.status !== 'teaching') continue
    const courses = coursesOn(rows, weekdayIndex(date), hit.week)
    if (courses.length > 0) return { date, week: hit.week, courses }
  }
  return null
}

// --- 渲染 ---

/**
 * 生成今日课程文本（纯文本，无 Markdown）。
 * @param {object} input
 * @param {string} input.date
 * @param {{status:string, week?:number, label?:string}} input.resolution
 * @param {object[]} input.courses
 * @param {object|null} input.next
 * @param {number} [input.nowMinutes] 传入后会给已结束的课打标
 */
export function renderCourses(input) {
  const { date, resolution, courses = [], next = null, nowMinutes } = input
  const lines = []

  const weekText = typeof resolution.week === 'number' ? ` · 第 ${resolution.week} 周` : ''
  lines.push(`【今日课程】${formatDate(date)}${weekText}`)

  if (resolution.status === 'outside') {
    lines.push('今天不在学期内（寒暑假或学期之间）')
  } else if (resolution.status === 'off') {
    lines.push(`今天没有课：${resolution.label}`)
  } else if (resolution.status === 'holiday') {
    lines.push(`今天没有课：${resolution.label}放假`)
  } else if (courses.length === 0) {
    const weekend = weekdayIndex(date) >= 5
    lines.push(weekend ? '今天没有课（周末）' : '今天没有课')
  } else {
    const conflicts = findConflicts(courses)
    for (const c of courses) {
      const campus = campusOf(c.room)
      const tags = []
      if (campus === '苏州校区') tags.push('苏州校区')
      if (typeof nowMinutes === 'number' && nowMinutes > c.time.end) tags.push('已结束')
      const suffix = tags.length > 0 ? `  [${tags.join(' / ')}]` : ''
      lines.push(`${c.timeText}  ${c.course}  ${c.room}${suffix}`)
    }
    if (conflicts.length > 0) {
      lines.push(`⚠ 时间冲突：${conflicts.map(([a, b]) => `${a.course} / ${b.course}`).join('；')}`)
    }
  }

  if (next) {
    const first = next.courses[0]
    lines.push('')
    lines.push(`下一节：${formatDate(next.date)} ${minutesToText(first.time.start)} ${first.course}（${first.room}）`)
  }

  return lines.join('\n')
}
