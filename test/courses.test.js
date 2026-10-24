import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseWeeks, parseTimeRange, parseCsv, loadSchedule, resolveDate, coursesOn,
  findConflicts, weekdayIndex, formatDate, addDays, campusOf, nextTeachingDay, renderCourses,
} from '../scripts/courses.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const termData = JSON.parse(await readFile(resolve(ROOT, 'data', 'term.json'), 'utf8'))
const rows = loadSchedule(await readFile(resolve(ROOT, 'course_schedule.csv'), 'utf8'))

// --- 周次解析 ---

test('parseWeeks: CSV 里出现的每种写法', () => {
  assert.deepEqual([...parseWeeks('5, 11')].sort((a, b) => a - b), [5, 11])
  assert.deepEqual([...parseWeeks('1, 4, 8, 10')].sort((a, b) => a - b), [1, 4, 8, 10])
  assert.deepEqual([...parseWeeks('1-3, 4-5')].sort((a, b) => a - b), [1, 2, 3, 4, 5])
  assert.deepEqual([...parseWeeks('8-13')].sort((a, b) => a - b), [8, 9, 10, 11, 12, 13])
  assert.deepEqual([...parseWeeks('1, 3, 4-6, 8-10')].sort((a, b) => a - b), [1, 3, 4, 5, 6, 8, 9, 10])
  assert.deepEqual([...parseWeeks('2, 7')].sort((a, b) => a - b), [2, 7])
  assert.deepEqual([...parseWeeks('13')], [13])
})

test('parseWeeks: 坏数据必须报错，不能静默跳过', () => {
  assert.throws(() => parseWeeks('13-9'), /区间倒置/)
  assert.throws(() => parseWeeks('0'), /越界/)
  assert.throws(() => parseWeeks('31'), /越界/)
  assert.throws(() => parseWeeks('第一周'), /无法解析/)
  assert.throws(() => parseWeeks('  '), /为空/)
})

test('parseTimeRange: 正常与异常', () => {
  assert.deepEqual(parseTimeRange('09:00-09:50'), { start: 540, end: 590 })
  assert.deepEqual(parseTimeRange('18:00-18:50'), { start: 1080, end: 1130 })
  assert.throws(() => parseTimeRange('09:50-09:00'), /无效/)
  assert.throws(() => parseTimeRange('9点'), /无法解析/)
})

// --- CSV 解析 ---

test('parseCsv: 引号内的逗号不切列', () => {
  const rows = parseCsv('a,b\n"1, 2",x\n')
  assert.deepEqual(rows, [['a', 'b'], ['1, 2', 'x']])
})

test('loadSchedule: 真实课表 30 行，无重复无空', () => {
  assert.equal(rows.length, 30)
  for (const r of rows) {
    assert.ok(r.course.length > 0, `第 ${r.line} 行课程名为空`)
    assert.ok(r.room.length > 0, `第 ${r.line} 行教室为空`)
    assert.ok(r.weeks.size > 0)
  }
})

test('loadSchedule: 缺列/坏星期要报错', () => {
  assert.throws(() => loadSchedule('Day,Time,Course,Weeks\n周一,09:00-09:50,X,1\n'), /缺少列：Room/)
  assert.throws(() => loadSchedule('Day,Time,Course,Weeks,Room\n周八,09:00-09:50,X,1,R\n'), /未知星期/)
})

// --- 日期 → 周次 ---

test('resolveDate: 关键日期（周次表最容易错的几处）', () => {
  const cases = [
    ['2026-08-31', 'off', null],       // Week 0 注册
    ['2026-09-07', 'teaching', 1],
    ['2026-09-25', 'holiday', 3],      // 中秋
    ['2026-09-28', 'off', null],       // 国庆（无周次）
    ['2026-10-04', 'off', null],
    ['2026-10-05', 'teaching', 4],     // ← 国庆后第一周必须是第 4 周
    ['2026-10-24', 'teaching', 6],
    ['2026-12-13', 'teaching', 13],
    ['2026-12-15', 'off', null],       // 阅读周
    ['2027-01-01', 'off', null],       // 考试周
    ['2027-08-01', 'off', null],
    ['2027-09-06', 'outside', null],   // 学期外
    ['2026-08-30', 'outside', null],
  ]
  for (const [date, status, week] of cases) {
    const r = resolveDate(termData, date)
    assert.equal(r.status, status, `${date} 状态应为 ${status}`)
    if (week !== null) assert.equal(r.week, week, `${date} 周次应为 ${week}`)
  }
})

test('resolveDate: 春学期第 11 周只有 5/3 和 5/4 放假', () => {
  assert.equal(resolveDate(termData, '2027-05-03').status, 'holiday')
  assert.equal(resolveDate(termData, '2027-05-04').status, 'holiday')
  assert.equal(resolveDate(termData, '2027-05-05').status, 'teaching')
  assert.equal(resolveDate(termData, '2027-05-05').week, 11)
  assert.equal(resolveDate(termData, '2027-05-06').status, 'teaching')
  assert.equal(resolveDate(termData, '2027-04-05').status, 'holiday')
})

test('weekdayIndex / formatDate', () => {
  assert.equal(weekdayIndex('2026-10-24'), 5) // 周六
  assert.equal(formatDate('2026-10-24'), '10-24 周六')
  assert.equal(addDays('2026-10-31', 1), '2026-11-01')
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
})

// --- 选课 ---

test('coursesOn: 第 6 周周六没有课', () => {
  assert.deepEqual(coursesOn(rows, 5, 6), [])
})

test('coursesOn: 第 11 周周一有 2 门（但那天放假）', () => {
  const list = coursesOn(rows, 0, 11)
  assert.equal(list.length, 2)
  assert.deepEqual(list.map(c => c.course), ['INF101TC Lecture', 'MFE103TC Lecture'])
})

test('coursesOn: 第 11 周周三有 2 门，按时间排序', () => {
  const list = coursesOn(rows, 2, 11)
  assert.deepEqual(list.map(c => `${c.timeText} ${c.course}`), [
    '14:00-15:50 MFE104TC Lab',
    '16:00-17:50 MFE104TC Lecture',
  ])
})

test('findConflicts: 真课表里零冲突', () => {
  for (let day = 0; day < 7; day++) {
    for (let week = 1; week <= 13; week++) {
      const list = coursesOn(rows, day, week)
      assert.equal(findConflicts(list).length, 0, `第 ${week} 周 ${day} 有冲突`)
    }
  }
})

test('campusOf: 太仓 / 苏州', () => {
  assert.equal(campusOf('TC-DE-2001'), '太仓校区')
  assert.equal(campusOf('SIP-SA136'), '苏州校区')
  assert.equal(campusOf(''), null)
})

test('nextTeachingDay: 从 10/24 出发找到 10/27', () => {
  const next = nextTeachingDay(rows, termData, '2026-10-24')
  assert.equal(next.date, '2026-10-27')
  assert.equal(next.week, 7)
})

test('nextTeachingDay: 学期末之后返回 null', () => {
  assert.equal(nextTeachingDay(rows, termData, '2026-12-12', 3), null)
})

// --- 渲染 ---

test('renderCourses: 周末无课', () => {
  const text = renderCourses({
    date: '2026-10-24',
    resolution: resolveDate(termData, '2026-10-24'),
    courses: [],
    next: nextTeachingDay(rows, termData, '2026-10-24'),
  })
  assert.match(text, /【今日课程】10-24 周六 · 第 6 周/)
  assert.match(text, /今天没有课（周末）/)
  assert.match(text, /下一节：10-27 周二 13:00 ENT103TC Practical/)
})

test('renderCourses: 放假要有原因，不能只说"没课"', () => {
  const text = renderCourses({
    date: '2026-09-25',
    resolution: resolveDate(termData, '2026-09-25'),
    courses: [],
  })
  assert.match(text, /今天没有课：中秋节放假/)
  assert.match(text, /第 3 周/)
})

test('renderCourses: 停课块给出假期名', () => {
  const text = renderCourses({
    date: '2026-10-02',
    resolution: resolveDate(termData, '2026-10-02'),
    courses: [],
  })
  assert.match(text, /今天没有课：国庆假期（学校关闭）/)
  assert.doesNotMatch(text, /第 \d+ 周/)
})

test('renderCourses: 有课时列时间/课程/教室，已结束加标', () => {
  // 第 6 周周三：Seminar(6) + Tutorial(6) + RBE Tutorial(1-3,4-6)
  const resolution = resolveDate(termData, '2026-10-21')
  const courses = coursesOn(rows, weekdayIndex('2026-10-21'), resolution.week)
  const text = renderCourses({ date: '2026-10-21', resolution, courses, nowMinutes: 23 * 60 })
  assert.equal(courses.length, 3)
  assert.match(text, /14:00-15:50  MFE113TC Seminar  TC-B-3046/)
  assert.match(text, /18:00-18:50  RBE101TC Tutorial  TC-FG-2001/)
  assert.match(text, /已结束/)
  assert.doesNotMatch(text, /\*\*/)
})

test('renderCourses: 苏州校区的课要标出来', () => {
  const text = renderCourses({
    date: '2026-10-23',
    resolution: { status: 'teaching', week: 6 },
    courses: [{ timeText: '11:00-12:50', course: 'X', room: 'SIP-SA136', time: { start: 660, end: 770 } }],
  })
  assert.match(text, /苏州校区/)
})
