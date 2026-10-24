/**
 * 自算风险层：纯函数，不碰网络、不碰时钟、不读配置以外的任何输入。
 *
 * 重要边界：这里输出的是**风险提示**，不是气象预警信号。
 * 阈值参照国标（风力等级 GB/T 28591、降水量等级 GB/T 28592、雾的等级等），
 * 但判定由本脚本完成，与气象台发布的蓝黄橙红预警没有对应关系。
 */

const BEAUFORT_UPPER = [0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7]

/** 风速(m/s) → 蒲福风级（0–12）。非数字返回 null。 */
export function beaufort(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null
  for (let level = 0; level < BEAUFORT_UPPER.length; level++) {
    if (ms < BEAUFORT_UPPER[level]) return level
  }
  return 12
}

/** 24h 降水量(mm) → 降水量等级（GB/T 28592）。 */
export function rainGrade(mm) {
  if (typeof mm !== 'number' || !Number.isFinite(mm)) return null
  if (mm < 0.1) return '无降水'
  if (mm < 10) return '小雨'
  if (mm < 25) return '中雨'
  if (mm < 50) return '大雨'
  if (mm < 100) return '暴雨'
  if (mm < 250) return '大暴雨'
  return '特大暴雨'
}

/** 能见度(m) → 雾的等级（GB/T 27964 简化）。 */
export function fogGrade(m) {
  if (typeof m !== 'number' || !Number.isFinite(m)) return null
  if (m < 50) return '特强浓雾'
  if (m < 200) return '强浓雾'
  if (m < 500) return '浓雾'
  if (m < 1000) return '雾'
  return null
}

/** 风向角度 → 八方位中文。 */
export function windDirText(deg) {
  if (typeof deg !== 'number' || !Number.isFinite(deg)) return null
  const dirs = ['北', '东北', '东', '东南', '南', '西南', '西', '西北']
  return `${dirs[Math.round(((deg % 360) + 360) % 360 / 45) % 8]}风`
}

/** WMO 天气代码 → 中文短句。 */
export function weatherText(code) {
  const table = {
    0: '晴', 1: '大致晴朗', 2: '多云', 3: '阴',
    45: '雾', 48: '冻雾',
    51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨',
    56: '冻毛毛雨', 57: '强冻毛毛雨',
    61: '小雨', 63: '中雨', 65: '大雨',
    66: '冻雨', 67: '强冻雨',
    71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
    80: '小阵雨', 81: '阵雨', 82: '强阵雨',
    85: '小阵雪', 86: '大阵雪',
    95: '雷阵雨', 96: '雷阵雨伴小冰雹', 99: '雷阵雨伴大冰雹',
  }
  if (typeof code !== 'number') return '未知'
  return table[code] ?? `未知(${code})`
}

/** 今天的逐小时切片（按时区已经由请求参数对齐，这里只按日期前缀筛）。 */
function hoursOfDay(hours, date) {
  return hours.filter(h => h.date === date)
}

/** 24 小时窗口内最大的连续 12 小时降水量之和。 */
export function maxRolling12h(dayHours) {
  const values = dayHours.map(h => (typeof h.precip === 'number' ? h.precip : 0))
  if (values.length < 12) return values.reduce((a, b) => a + b, 0)
  let best = 0
  for (let i = 0; i + 12 <= values.length; i++) {
    const sum = values.slice(i, i + 12).reduce((a, b) => a + b, 0)
    if (sum > best) best = sum
  }
  return best
}

/**
 * 评估一天的风险。
 *
 * @param {{days: object[], hours: object[]}} data normalize() 的输出
 * @param {object} thresholds 配置里的 thresholds
 * @param {{startHour: number, endHour: number}} morningWindow 早晨窗口（大雾只看这段）
 * @returns {{items: object[], derived: object}}
 */
export function evaluate(data, thresholds, morningWindow = { startHour: 6, endHour: 10 }) {
  const today = data.days?.[0]
  if (!today) throw new Error('数据里没有今天')

  const todayHours = hoursOfDay(data.hours ?? [], today.date)
  const morning = todayHours.filter(h => h.hour >= morningWindow.startHour && h.hour <= morningWindow.endHour)
  const morningVis = morning.map(h => h.visibility).filter(v => typeof v === 'number')
  const minMorningVis = morningVis.length > 0 ? Math.min(...morningVis) : null

  const gustMax = today.gustMax
  const gustLevel = beaufort(gustMax)
  const rain24 = typeof today.precipSum === 'number' ? today.precipSum : null
  const max12h = todayHours.length > 0 ? maxRolling12h(todayHours) : null
  const uvMax = today.uvMax
  const drop48 = (() => {
    const day2 = data.days?.[2]
    if (!day2 || typeof today.tempMin !== 'number' || typeof day2.tempMin !== 'number') return null
    return { drop: today.tempMin - day2.tempMin, day2Min: day2.tempMin }
  })()

  const items = []
  const push = (severity, id, title, detail) => items.push({ severity, id, title, detail })

  // --- 大风 ---
  if (typeof gustMax === 'number') {
    if (gustMax >= thresholds.windGust.severe) {
      push('alert', 'wind', '强风', `阵风 ${gustMax.toFixed(1)} m/s（${gustLevel} 级），尽量避免骑行与高空作业`)
    } else if (gustMax >= thresholds.windGust.alert) {
      push('alert', 'wind', '大风', `阵风 ${gustMax.toFixed(1)} m/s（${gustLevel} 级），注意固定户外物品`)
    } else if (gustMax >= thresholds.windGust.warn) {
      push('warn', 'wind', '风力偏大', `阵风 ${gustMax.toFixed(1)} m/s（${gustLevel} 级）`)
    }
  }

  // --- 降水 ---
  if (typeof rain24 === 'number') {
    if (rain24 >= thresholds.rain24h.alert) {
      push('alert', 'rain', '强降水', `24h 累计 ${rain24.toFixed(1)}mm，${rainGrade(rain24)}量级，注意低洼路段积水`)
    } else if (rain24 >= thresholds.rain24h.warn) {
      push('alert', 'rain', '暴雨量级', `24h 累计 ${rain24.toFixed(1)}mm，${rainGrade(rain24)}量级`)
    } else if (rain24 >= thresholds.rain24h.info) {
      push('info', 'rain', '明显降水', `24h 累计 ${rain24.toFixed(1)}mm，${rainGrade(rain24)}量级`)
    }
  }

  // --- 降雪 ---
  if (typeof today.snowfallSum === 'number' && today.snowfallSum > 0) {
    push('warn', 'snow', '有降雪', `预计降雪 ${today.snowfallSum.toFixed(1)}cm，路面可能湿滑`)
  }

  // --- 高温 ---
  if (typeof today.tempMax === 'number') {
    if (today.tempMax >= thresholds.heat.alert) {
      push('alert', 'heat', '强高温', `最高 ${today.tempMax.toFixed(1)}℃，减少户外活动、注意补水`)
    } else if (today.tempMax >= thresholds.heat.warn) {
      push('warn', 'heat', '高温', `最高 ${today.tempMax.toFixed(1)}℃，午后注意防晒补水`)
    }
  }

  // --- 寒潮（48h 降温） ---
  if (drop48 && drop48.drop >= thresholds.cold.drop && drop48.day2Min <= thresholds.cold.minAbs) {
    const severity = drop48.drop >= 12 ? 'alert' : 'warn'
    push(severity, 'cold', '大幅降温', `48h 内最低气温下降 ${drop48.drop.toFixed(1)}℃ 至 ${drop48.day2Min.toFixed(1)}℃，注意添衣`)
  }

  // --- 大雾（只看早晨窗口） ---
  if (typeof minMorningVis === 'number') {
    const grade = fogGrade(minMorningVis)
    if (minMorningVis < thresholds.fog.severe) {
      push('alert', 'fog', grade, `早晨能见度低至 ${Math.round(minMorningVis)}m，出行务必减速`)
    } else if (minMorningVis < thresholds.fog.alert) {
      push('alert', 'fog', grade, `早晨能见度 ${Math.round(minMorningVis)}m`)
    } else if (minMorningVis < thresholds.fog.warn) {
      push('warn', 'fog', grade, `早晨能见度 ${Math.round(minMorningVis)}m`)
    }
  }

  // --- 道路结冰 ---
  if (
    typeof today.tempMin === 'number' && today.tempMin <= thresholds.ice.temp &&
    typeof rain24 === 'number' && rain24 > thresholds.ice.precip
  ) {
    push('alert', 'ice', '道路结冰', `最低 ${today.tempMin.toFixed(1)}℃ 且有降水，注意路面打滑`)
  }

  // --- 雷电 ---
  const thunderCodes = new Set([95, 96, 99])
  const hasThunder =
    thunderCodes.has(today.weatherCode) ||
    todayHours.some(h => thunderCodes.has(h.weatherCode))
  if (hasThunder) push('warn', 'thunder', '雷电', '有雷阵雨，避免空旷地带停留')

  // --- 紫外线 ---
  if (typeof uvMax === 'number' && uvMax >= thresholds.uv.warn) {
    push('info', 'uv', '紫外线强', `UV 指数 ${uvMax.toFixed(1)}，长时间户外注意防晒`)
  }

  const order = { alert: 0, warn: 1, info: 2 }
  items.sort((a, b) => (order[a.severity] - order[b.severity]) || a.id.localeCompare(b.id))

  return {
    items,
    derived: {
      date: today.date,
      gustMax,
      gustLevel,
      rain24,
      max12h,
      rainGrade: rainGrade(rain24),
      minMorningVis,
      uvMax,
      drop48,
      windDir: windDirText(today.windDir),
    },
  }
}
