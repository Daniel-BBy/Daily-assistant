import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  beaufort, rainGrade, fogGrade, windDirText, weatherText, maxRolling12h, evaluate,
} from '../scripts/risks.js'
import { clothingAdvice, renderBrief, dayLabel } from '../scripts/render.js'

const THRESHOLDS = {
  windGust: { warn: 10.8, alert: 13.9, severe: 20.8 },
  rain24h: { info: 10, warn: 50, alert: 100 },
  heat: { warn: 35, alert: 37 },
  cold: { drop: 8, minAbs: 4 },
  fog: { warn: 1000, alert: 500, severe: 200 },
  ice: { temp: 0, precip: 0.1 },
  uv: { warn: 8 },
}

/** 造 24 小时数据；precip 由调用方给一个生成函数。 */
function makeHours(date, { precip = () => 0, visibility = () => 20000, code = () => 1 } = {}) {
  return Array.from({ length: 24 }, (_, hour) => ({
    time: `${date}T${String(hour).padStart(2, '0')}:00`,
    date, hour,
    temp: 18, feels: 18,
    precip: precip(hour),
    precipProb: 50,
    weatherCode: code(hour),
    visibility: visibility(hour),
    gust: 5,
    snowfall: 0,
  }))
}

function makeDay(overrides = {}) {
  return {
    date: '2026-10-24',
    weatherCode: 81,
    tempMax: 23.5, tempMin: 14.7,
    feelsMax: 25, feelsMin: 11,
    precipSum: 62, precipProb: 96,
    rainSum: 62, showersSum: 62, snowfallSum: 0,
    windMax: 9.1, gustMax: 14.2, windDir: 45,
    uvMax: 3.2,
    sunrise: '2026-10-24T06:04', sunset: '2026-10-24T17:15',
    ...overrides,
  }
}

// --- 单位换算与分级 ---

test('beaufort: 边界值落在正确风级', () => {
  assert.equal(beaufort(0), 0)
  assert.equal(beaufort(10.7), 5)
  assert.equal(beaufort(10.8), 6)
  assert.equal(beaufort(13.9), 7) // 大风蓝色预警的门槛值
  assert.equal(beaufort(17.2), 8)
  assert.equal(beaufort(20.8), 9)
  assert.equal(beaufort(33), 12)
  assert.equal(beaufort(null), null)
})

test('rainGrade: 按 GB/T 28592 分级', () => {
  assert.equal(rainGrade(0), '无降水')
  assert.equal(rainGrade(9.9), '小雨')
  assert.equal(rainGrade(10), '中雨')
  assert.equal(rainGrade(24.9), '中雨')
  assert.equal(rainGrade(25), '大雨')
  assert.equal(rainGrade(49.9), '大雨')
  assert.equal(rainGrade(50), '暴雨')
  assert.equal(rainGrade(99.9), '暴雨')
  assert.equal(rainGrade(250), '特大暴雨')
})

test('fogGrade: 按能见度分级', () => {
  assert.equal(fogGrade(20000), null)
  assert.equal(fogGrade(999), '雾')
  assert.equal(fogGrade(499), '浓雾')
  assert.equal(fogGrade(199), '强浓雾')
  assert.equal(fogGrade(49), '特强浓雾')
})

test('windDirText: 角度换算八方位', () => {
  assert.equal(windDirText(0), '北风')
  assert.equal(windDirText(45), '东北风')
  assert.equal(windDirText(180), '南风')
  assert.equal(windDirText(350), '北风')
  assert.equal(windDirText(undefined), null)
})

test('weatherText: 未知代码不崩', () => {
  assert.equal(weatherText(81), '阵雨')
  assert.equal(weatherText(999), '未知(999)')
  assert.equal(weatherText(undefined), '未知')
})

test('maxRolling12h: 取最大连续 12 小时', () => {
  const hours = Array.from({ length: 24 }, (_, h) => ({ precip: h < 12 ? 1 : 5 }))
  assert.equal(maxRolling12h(hours), 60) // 后 12 小时全是 5
  assert.equal(maxRolling12h([{ precip: 1 }, { precip: 2 }]), 3) // 不足 12 小时则求和
})

// --- 风险判定 ---

test('evaluate: 暴雨 + 大风 + 晨雾 三项同时命中', () => {
  const day = makeDay()
  const hours = makeHours('2026-10-24', {
    precip: h => (h >= 8 && h < 20 ? 62 / 12 : 0), // 连续 12 小时共 62mm
    visibility: h => (h >= 6 && h <= 9 ? 800 : 20000),
    code: h => (h === 15 ? 95 : 81),
  })
  const { items, derived } = evaluate({ days: [day], hours }, THRESHOLDS)

  const ids = items.map(i => i.id)
  assert.ok(ids.includes('rain'), '应命中降水')
  assert.ok(ids.includes('wind'), '应命中大风')
  assert.ok(ids.includes('fog'), '应命中大雾')
  assert.ok(ids.includes('thunder'), '应命中雷电')

  const rain = items.find(i => i.id === 'rain')
  assert.equal(rain.severity, 'alert')
  assert.match(rain.detail, /暴雨量级/)

  const wind = items.find(i => i.id === 'wind')
  assert.equal(wind.severity, 'alert')
  assert.match(wind.detail, /7 级/)

  assert.equal(derived.rainGrade, '暴雨')
  assert.equal(derived.gustLevel, 7)
  assert.ok(Math.abs(derived.max12h - 62) < 0.01)
})

test('evaluate: 平稳天气不产出任何风险项', () => {
  const day = makeDay({ tempMax: 22, tempMin: 16, precipSum: 0, gustMax: 6, uvMax: 4 })
  const hours = makeHours('2026-10-24', { code: () => 2 })
  const { items, derived } = evaluate({ days: [day], hours }, THRESHOLDS)
  assert.deepEqual(items, [])
  assert.equal(derived.rainGrade, '无降水')
})

test('evaluate: 40℃ 高温 + 道路结冰不会同时误判', () => {
  const hot = makeDay({ tempMax: 40, tempMin: 28, precipSum: 0, gustMax: 3, uvMax: 11 })
  const hotResult = evaluate({ days: [hot], hours: makeHours('2026-10-24') }, THRESHOLDS)
  assert.equal(hotResult.items.find(i => i.id === 'heat').severity, 'alert')
  assert.equal(hotResult.items.find(i => i.id === 'ice'), undefined)

  const icy = makeDay({ tempMax: 2, tempMin: -3, precipSum: 5, gustMax: 3, uvMax: 1 })
  const icyResult = evaluate({ days: [icy], hours: makeHours('2026-10-24') }, THRESHOLDS)
  assert.equal(icyResult.items.find(i => i.id === 'ice').severity, 'alert')
  assert.equal(icyResult.items.find(i => i.id === 'heat'), undefined)
})

test('evaluate: 48h 降温触发寒潮', () => {
  const d0 = makeDay({ tempMin: -1, precipSum: 0, gustMax: 3 })
  const d2 = makeDay({ date: '2026-10-26', tempMin: -10 })
  const { items } = evaluate({ days: [d0, makeDay(), d2], hours: makeHours('2026-10-24') }, THRESHOLDS)
  const cold = items.find(i => i.id === 'cold')
  assert.ok(cold, '应命中寒潮')
  assert.equal(cold.severity, 'warn') // 降 9℃：达到 8℃ 门槛但未到 12℃
})

test('evaluate: 字段缺失时静默跳过，不抛错', () => {
  const bare = { date: '2026-10-24' }
  const { items } = evaluate({ days: [bare], hours: [] }, THRESHOLDS)
  assert.deepEqual(items, [])
})

test('evaluate: 没有 days 时抛错而不是编造', () => {
  assert.throws(() => evaluate({ days: [], hours: [] }, THRESHOLDS), /没有今天/)
})

// --- 渲染 ---

test('dayLabel: 日期与星期', () => {
  assert.equal(dayLabel('2026-10-24', 'Asia/Shanghai'), '10-24 周六')
  assert.equal(dayLabel('2026-10-23', 'Asia/Shanghai'), '10-23 周五')
})

test('clothingAdvice: 温差大时提示叠穿', () => {
  const day = makeDay({ tempMin: 12, tempMax: 24, precipProb: 10, precipSum: 0 })
  const advice = clothingAdvice(day, { gustLevel: 2 }, THRESHOLDS)
  assert.match(advice, /温差/)
  assert.match(advice, /叠穿/)
  assert.doesNotMatch(advice, /带伞/)
})

test('clothingAdvice: 有雨时提示带伞', () => {
  const day = makeDay({ tempMin: 18, tempMax: 22, precipProb: 80 })
  assert.match(clothingAdvice(day, { gustLevel: 2, minMorningVis: 20000 }, THRESHOLDS), /带伞/)
})

test('renderBrief: 正常简报包含关键段落且标注未接入预警', () => {
  const day = makeDay()
  const { items, derived } = evaluate(
    { days: [day], hours: makeHours('2026-10-24', { precip: () => 0 }) },
    THRESHOLDS,
  )
  const text = renderBrief({
    place: { name: '太仓', timezone: 'Asia/Shanghai' },
    day, derived, items, thresholds: THRESHOLDS, weatherText: '阵雨',
  })
  assert.match(text, /^【太仓 · 10-24 周六】/)
  assert.match(text, /气温 14\.7~23\.5℃/)
  assert.match(text, /阵雨/)
  assert.match(text, /穿衣/)
  assert.match(text, /风险提示（自算，非官方预警）/)
  assert.match(text, /官方预警：未接入/)
  assert.doesNotMatch(text, /\*\*/, '不应输出 Markdown')
})

test('renderBrief: 无风险项时明确写"无明显风险项"', () => {
  const day = makeDay({ precipSum: 0, gustMax: 3, uvMax: 2 })
  const { items, derived } = evaluate({ days: [day], hours: makeHours('2026-10-24') }, THRESHOLDS)
  const text = renderBrief({
    place: { name: '太仓', timezone: 'Asia/Shanghai' },
    day, derived, items, thresholds: THRESHOLDS, weatherText: '多云',
  })
  assert.match(text, /今日无明显风险项/)
})

test('renderBrief: 降级时只说取不到，不给任何天气数字', () => {
  const text = renderBrief({
    place: { name: '太仓', timezone: 'Asia/Shanghai' },
    day: { date: '2026-10-24' },
    derived: {}, items: [], thresholds: THRESHOLDS,
    degraded: '天气数据获取失败：HTTP 503',
  })
  assert.match(text, /天气数据获取失败/)
  assert.match(text, /今日天气未知，请勿据此安排出行/)
  assert.doesNotMatch(text, /℃/, '降级时不得出现温度数字')
  assert.doesNotMatch(text, /mm/, '降级时不得出现降水量')
})
