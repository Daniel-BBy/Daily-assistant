/**
 * 渲染层：把结构化天气 + 风险项拼成一条适合 QQ 阅读的纯文本。
 *
 * 约束：
 * - 输出纯文本，不含 Markdown（QQ 不渲染）。
 * - 穿衣建议是确定性规则，不是模型生成——同样的输入永远得到同样的输出，便于测试。
 * - 数据缺失时写"未知"，不推断、不留空让人误会。
 */


/** 从 `YYYY-MM-DD` 得到"10-24 周五"。用正午时间构造，避开时区把日期推前一天。 */
export function dayLabel(date, timezone = 'Asia/Shanghai') {
  const [y, m, d] = date.split('-').map(Number)
  // 以 UTC 正午为锚点，再取该时区的星期，跨时区也不会错位
  const noonUtc = Date.UTC(y, m - 1, d, 4, 0, 0) // +08:00 = UTC 04:00
  const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'short', timeZone: timezone })
    .format(new Date(noonUtc))
  return `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} ${weekday}`
}

function num(value, digits = 1, fallback = '未知') {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : fallback
}

/** 基于当日最低温和温差给基础穿衣建议（确定性规则）。 */
export function clothingAdvice(day, derived, thresholds) {
  const tmin = day.tempMin
  const tmax = day.tempMax
  const parts = []

  if (typeof tmin === 'number') {
    let base
    if (tmin < -5) base = '厚羽绒服'
    else if (tmin < 0) base = '羽绒服/厚棉衣'
    else if (tmin < 5) base = '厚外套 + 毛衣'
    else if (tmin < 10) base = '外套 + 长袖'
    else if (tmin < 15) base = '薄外套 + 长袖'
    else if (tmin < 20) base = '长袖或薄外搭'
    else if (tmin < 25) base = '短袖 + 薄外搭'
    else if (tmin < 30) base = '短袖'
    else base = '短袖，注意防暑'
    parts.push(base)
  }

  if (typeof tmin === 'number' && typeof tmax === 'number') {
    const range = tmax - tmin
    if (range >= 10) parts.push(`早晚温差 ${range.toFixed(1)}℃，建议叠穿、中午可减`)
    else if (range >= 7) parts.push('早晚略凉，备一件外搭')
  }

  const rainy = (day.precipProb ?? 0) >= 50 || (day.precipSum ?? 0) >= 1
  if (rainy) parts.push('带伞')
  if ((derived.gustLevel ?? 0) >= 5) parts.push('风大，注意防风')
  if ((day.uvMax ?? 0) >= thresholds.uv.warn) parts.push('防晒')
  if (typeof derived.minMorningVis === 'number' && derived.minMorningVis < thresholds.fog.warn) {
    parts.push('早晨能见度低，通勤留余量')
  }
  if ((day.tempMin ?? 99) <= 0) parts.push('注意防滑保暖')

  return parts.join('；')
}

const SEVERITY_MARK = { alert: '⚠️', warn: '⚠', info: '·' }

/**
 * 渲染完整简报。
 * @param {{place: object, day: object, derived: object, items: object[], thresholds: object, degraded?: string}} input
 */
export function renderBrief(input) {
  const { place, day, derived, items, thresholds } = input
  const label = dayLabel(day.date, place.timezone)
  const lines = []

  if (input.degraded) {
    lines.push(`【${place.name} · ${label}】`)
    lines.push(`⚠️ ${input.degraded}`)
    lines.push('今日天气未知，请勿据此安排出行。')
    lines.push('')
    lines.push('官方预警：未接入（本简报不含官方气象预警信息）')
    return lines.join('\n')
  }

  lines.push(`【${place.name} · ${label}】`)

  // 气温
  const tempLine =
    `气温 ${num(day.tempMin)}~${num(day.tempMax)}℃` +
    (typeof day.feelsMin === 'number' && typeof day.feelsMax === 'number'
      ? `（体感 ${num(day.feelsMin)}~${num(day.feelsMax)}℃）`
      : '')
  lines.push(tempLine)

  // 天气现象 + 降水概率
  const weatherBits = [input.weatherText ?? '未知']
  if (typeof day.precipProb === 'number') weatherBits.push(`降水概率 ${Math.round(day.precipProb)}%`)
  lines.push(`天气 ${weatherBits.join(' · ')}`)

  // 降水量
  if (typeof derived.rain24 === 'number') {
    const bits = [`全天 ${derived.rain24.toFixed(1)}mm`]
    if (derived.rainGrade) bits.push(`${derived.rainGrade}量级`)
    if (typeof derived.max12h === 'number' && derived.max12h > 0) bits.push(`最大 12h ${derived.max12h.toFixed(1)}mm`)
    if (typeof day.snowfallSum === 'number' && day.snowfallSum > 0) bits.push(`降雪 ${day.snowfallSum.toFixed(1)}cm`)
    lines.push(`降水 ${bits.join('，')}`)
  } else if (typeof day.snowfallSum === 'number' && day.snowfallSum > 0) {
    lines.push(`降水 降雪 ${day.snowfallSum.toFixed(1)}cm`)
  }

  // 风
  const windBits = []
  if (derived.windDir) windBits.push(derived.windDir)
  if (typeof day.windMax === 'number') windBits.push(`${num(day.windMax)} m/s`)
  if (typeof derived.gustMax === 'number') {
    windBits.push(`阵风 ${num(derived.gustMax)} m/s（${derived.gustLevel} 级）`)
  }
  if (windBits.length > 0) lines.push(`风 ${windBits.join('，')}`)

  // 紫外线
  if (typeof day.uvMax === 'number') {
    lines.push(`紫外线 UV ${num(day.uvMax)}${day.uvMax >= thresholds.uv.warn ? '（强）' : ''}`)
  }

  // 穿衣
  const advice = clothingAdvice(day, derived, thresholds)
  if (advice) lines.push(`穿衣 ${advice}`)

  // 今日课程（由 courses 模块生成，已自带标题行）
  if (input.courses) {
    lines.push('')
    lines.push(input.courses)
  }

  // 风险
  lines.push('')
  if (items.length === 0) {
    lines.push('风险提示（自算，非官方预警）：今日无明显风险项')
  } else {
    lines.push('风险提示（自算，非官方预警）')
    for (const item of items) {
      lines.push(`${SEVERITY_MARK[item.severity] ?? '·'} ${item.title}：${item.detail}`)
    }
  }

  // 明确标注预警状态 —— 沉默不等于安全
  lines.push('')
  lines.push('官方预警：未接入（本简报不含官方气象预警信息，台风、暴雨红色预警等请以气象台发布为准）')

  return lines.join('\n')
}
