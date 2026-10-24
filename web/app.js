/**
 * 每日简报 · 手机页
 *
 * 和命令行版共用同一套纯逻辑（scripts/*.js）：取数、判定、渲染规则完全一致，
 * 这样"网页上看到的"和"消息里收到的"不会两套行为。
 *
 * 数据：data/term.json（校历）、course_schedule.csv（课表）、brief.config.json（阈值与坐标）
 * 网络：Open-Meteo（免 key），浏览器直连，所以页面打开就有最新天气。
 */

import { fetchForecast, normalize } from './lib/openmeteo.js'
import { evaluate, weatherText } from './lib/risks.js'
import { clothingAdvice } from './lib/render.js'
import {
  loadSchedule, resolveDate, coursesOn, nextTeachingDay,
  todayInZone, weekdayIndex, formatDate, campusOf, findConflicts,
} from './lib/courses.js'

const state = { term: null, rows: null, cfg: null, weather: null, weatherError: null, loaded: false }

const $ = id => document.getElementById(id)
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

async function fetchJson(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`)
  return r.json()
}

async function main() {
  try {
    const [term, csv, cfg] = await Promise.all([
      fetchJson('data/term.json'),
      fetch('data/course_schedule.csv').then(r => {
        if (!r.ok) throw new Error(`课表 → HTTP ${r.status}`)
        return r.text()
      }),
      fetchJson('data/brief.config.json'),
    ])
    state.term = term
    state.rows = loadSchedule(csv)
    state.cfg = cfg
    state.loaded = true
  } catch (error) {
    $('error').textContent = `数据加载失败：${error.message}`
    $('error').hidden = false
    return
  }

  const tz = state.cfg.place.timezone ?? 'Asia/Shanghai'
  $('date').value = todayInZone(tz)
  $('date').addEventListener('change', render)
  $('today').addEventListener('click', () => {
    $('date').value = todayInZone(tz)
    render()
  })

  render()

  // 新闻是独立的：抓不到就整块不显示，绝不阻塞课程和天气
  loadNews()

  // 天气单独拉：失败只影响天气卡片，不影响课程
  try {
    state.weather = normalize(await fetchForecast(state.cfg.place))
  } catch (error) {
    state.weatherError = error.message
  }
  render()
}

/** 当前时间的分钟数（目的地时区），用于给已结束的课打标。 */
function nowMinutes(tz) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date())
  const get = t => Number(p.find(x => x.type === t)?.value ?? 0)
  return get('hour') * 60 + get('minute')
}

function render() {
  if (!state.loaded) return
  const tz = state.cfg.place.timezone ?? 'Asia/Shanghai'
  const today = todayInZone(tz)
  const date = $('date').value || today
  const isToday = date === today

  const resolution = resolveDate(state.term, date)
  const week = resolution.week
  const courses = resolution.status === 'teaching'
    ? coursesOn(state.rows, weekdayIndex(date), week)
    : []

  document.title = `${formatDate(date)} · 每日简报`

  renderHeader(date, resolution, week)
  renderCourses(date, resolution, courses, isToday, tz)
  renderWeather(isToday)
  renderFooter()
}

function renderHeader(date, resolution, week) {
  $('day').textContent = formatDate(date)
  const badge = $('week')
  if (typeof week === 'number') {
    badge.textContent = `第 ${week} 周`
    badge.hidden = false
  } else {
    badge.hidden = true
  }

  const chips = []
  if (resolution.status === 'off' || resolution.status === 'holiday') chips.push(resolution.label)
  if (resolution.status === 'outside') chips.push('不在学期内')
  $('status').innerHTML = chips.map(c => `<span class="chip">${esc(c)}</span>`).join('')
}

function renderCourses(date, resolution, courses, isToday, tz) {
  const box = $('course')
  if (resolution.status === 'outside') {
    box.innerHTML = `<p class="muted">今天不在学期内（寒暑假或学期之间）</p>`
    return
  }
  if (resolution.status === 'off') {
    box.innerHTML = `<p class="muted">今天没有课 · ${esc(resolution.label)}</p>`
    return
  }
  if (resolution.status === 'holiday') {
    box.innerHTML = `<p class="muted">今天没有课 · ${esc(resolution.label)}放假</p>`
    return
  }
  if (courses.length === 0) {
    const weekend = weekdayIndex(date) >= 5
    box.innerHTML = `<p class="muted">今天没有课${weekend ? '（周末）' : ''}</p>`
    return
  }

  const now = isToday ? nowMinutes(tz) : null
  const conflicts = findConflicts(courses)
  const rows = courses.map(c => {
    const campus = campusOf(c.room)
    const done = now !== null && now > c.time.end
    const far = campus === '苏州校区'
    return `
      <li class="course${done ? ' done' : ''}">
        <span class="time">${esc(c.timeText)}</span>
        <span class="name">${esc(c.course)}</span>
        <span class="room">${esc(c.room)}${far ? ' <b class="tag">苏州</b>' : ''}${done ? ' <b class="tag">已结束</b>' : ''}</span>
      </li>`
  }).join('')

  const warn = conflicts.length > 0
    ? `<p class="warn">⚠ 时间冲突：${conflicts.map(([a, b]) => `${esc(a.course)} / ${esc(b.course)}`).join('；')}</p>`
    : ''

  box.innerHTML = `<ul class="courses">${rows}</ul>${warn}`
}

function renderWeather(isToday) {
  const box = $('weather')
  if (!isToday) {
    box.innerHTML = `<p class="muted">天气只显示今天 —— 切回今天可看实时数据。</p>`
    return
  }
  if (state.weatherError) {
    box.innerHTML = `<p class="muted">⚠️ 天气获取失败（${esc(state.weatherError)}）</p><p class="muted">今日天气未知，请勿据此安排出行。</p>`
    return
  }
  if (!state.weather) {
    box.innerHTML = `<p class="muted">正在获取天气…</p>`
    return
  }

  const d = state.weather.days[0]
  const cfg = state.cfg
  const { items, derived } = evaluate(state.weather, cfg.thresholds, cfg.morningWindow ?? { startHour: 6, endHour: 10 })
  const advice = clothingAdvice(d, derived, cfg.thresholds)

  const big = `
    <div class="temp">
      <b>${Math.round(d.tempMin)}°</b><span>~</span><b>${Math.round(d.tempMax)}°</b>
      <em>${esc(weatherText(d.weatherCode))}</em>
    </div>`

  const facts = []
  if (typeof d.precipProb === 'number') facts.push(`降水 ${Math.round(d.precipProb)}%`)
  if (typeof derived.rain24 === 'number') facts.push(`${derived.rain24.toFixed(1)}mm${derived.rainGrade ? `（${derived.rainGrade}）` : ''}`)
  if (typeof derived.gustMax === 'number') facts.push(`阵风 ${derived.gustLevel} 级`)
  if (typeof d.uvMax === 'number') facts.push(`UV ${d.uvMax.toFixed(1)}`)

  const riskRows = items.length === 0
    ? `<li class="ok">今日无明显风险项</li>`
    : items.map(i => `<li class="risk-${i.severity}">${esc(i.title)}：${esc(i.detail)}</li>`).join('')

  box.innerHTML = `
    ${big}
    <p class="facts">${facts.map(esc).join(' · ')}</p>
    ${advice ? `<p class="advice">穿衣：${esc(advice)}</p>` : ''}
    <ul class="risks">${riskRows}</ul>
    <p class="note">风险为自算（非官方预警）</p>`
}

function renderFooter() {
  const t = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  $('updated').textContent = `更新于 ${t} · 天气 Open-Meteo · 官方预警未接入`
}

/** 分类配色：和 CSS 里的 --c 变量配合，避免每个分类写一套 class。 */
const CAT_COLORS = {
  融资收购: '#f59e0b',
  产品发布: '#22d3ee',
  政策监管: '#fb7185',
  开源: '#34d399',
  研究: '#a78bfa',
  具身智能: '#60a5fa',
  行业: '#94a3b8',
}

async function loadNews() {
  let data
  try {
    const r = await fetch('data/news.json', { cache: 'no-cache' })
    if (!r.ok) return
    data = await r.json()
  } catch {
    return // 没有新闻数据时什么都不显示，不影响课程和天气
  }
  renderNews(data)
}

function renderNews(data) {
  const items = Array.isArray(data?.items) ? data.items : []
  if (items.length === 0) return

  $('news-date').textContent = String(data.date ?? '').replace(/-/g, '.')

  $('news-list').innerHTML = items.map((n, i) => {
    const color = CAT_COLORS[n.category] ?? CAT_COLORS.行业
    return `
      <li class="news-item">
        <span class="news-idx">${String(i + 1).padStart(2, '0')}</span>
        <div class="news-body">
          <div class="news-meta">
            <span class="news-cat" style="--c:${color}">${esc(n.category)}</span>
            <span class="news-src">${esc(n.source)}</span>
          </div>
          <a class="news-h" href="${esc(n.url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(n.title)}</a>
          <p class="news-p">${esc(n.summary)}</p>
        </div>
      </li>`
  }).join('')

  const t = data.generatedAt
    ? new Date(data.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' })
    : ''
  $('news-foot').textContent = `内容来自各媒体 · 版权归原作者${t ? ` · 生成于 ${t}` : ''}`
  $('news-panel').hidden = false
}

main()
