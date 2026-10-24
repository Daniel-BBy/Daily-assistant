/**
 * Open-Meteo 取数层：只负责"把远端 JSON 变成结构化对象"，不含任何判断逻辑。
 *
 * 设计约束：
 * - 只用 Node 内置能力（global fetch / AbortSignal.timeout），零依赖。
 * - 请求失败或字段缺失时抛错或返回 null，绝不补造数据。
 */

export const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'

/** 请求的字段。改这里 = 改数据面；风险规则读不到字段会自动跳过对应项。 */
const CURRENT_FIELDS = [
  'temperature_2m',
  'apparent_temperature',
  'relative_humidity_2m',
  'weather_code',
  'wind_speed_10m',
  'wind_gusts_10m',
  'is_day',
].join(',')

const HOURLY_FIELDS = [
  'temperature_2m',
  'apparent_temperature',
  'precipitation',
  'precipitation_probability',
  'weather_code',
  'visibility',
  'wind_gusts_10m',
  'snowfall',
].join(',')

const DAILY_FIELDS = [
  'weather_code',
  'temperature_2m_max',
  'temperature_2m_min',
  'apparent_temperature_max',
  'apparent_temperature_min',
  'precipitation_sum',
  'precipitation_probability_max',
  'rain_sum',
  'showers_sum',
  'snowfall_sum',
  'wind_speed_10m_max',
  'wind_gusts_10m_max',
  'wind_direction_10m_dominant',
  'uv_index_max',
  'sunrise',
  'sunset',
].join(',')

/** 组装请求 URL。坐标固定取自配置，避免"太仓"这类同名地名被解析到别的省。 */
export function buildForecastUrl(place) {
  const params = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    current: CURRENT_FIELDS,
    hourly: HOURLY_FIELDS,
    daily: DAILY_FIELDS,
    forecast_days: '3', // 第 3 天用于 48h 寒潮判断
    timezone: place.timezone ?? 'Asia/Shanghai', // 不用 auto：宿主时区不该影响"今天"的定义
    wind_speed_unit: 'ms', // 统一 m/s，风级换算才不需要再猜单位
    temperature_unit: 'celsius',
    precipitation_unit: 'mm',
  })
  return `${OPEN_METEO_FORECAST_URL}?${params.toString()}`
}

/**
 * 带重试的 GET。Open-Meteo 偶发 5xx/超时，重试两次足够。
 * 全部失败则抛出，由上层降级处理。
 */
export async function fetchForecast(place, options = {}) {
  const url = buildForecastUrl(place)
  const timeoutMs = options.timeoutMs ?? 15000
  const retries = options.retries ?? 2
  let lastError

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'dsh-daily-brief/0.1 (+local personal use)' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const json = await response.json()
      if (json?.error) throw new Error(json.reason ?? 'Open-Meteo 返回 error')
      return json
    } catch (error) {
      lastError = error
      if (attempt < retries) await sleep(1000 * (attempt + 1) ** 2)
    }
  }
  throw new Error(`天气数据获取失败：${lastError?.message ?? '未知错误'}`)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 取某个字段数组的第 i 个值，缺失/非数字返回 null（调用方负责跳过）。 */
function at(values, i) {
  const v = Array.isArray(values) ? values[i] : undefined
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * 把 Open-Meteo 响应收敛成本脚本认识的形状。
 * 所有数组按"天"和"小时"两条线拆开，缺字段一律 null。
 */
export function normalize(json) {
  const daily = json?.daily
  const hourly = json?.hourly
  if (!daily?.time || !Array.isArray(daily.time) || daily.time.length === 0) {
    throw new Error('天气数据缺少 daily.time，返回体不是预期形状')
  }

  const days = daily.time.map((date, i) => ({
    date,
    weatherCode: at(daily.weather_code, i),
    tempMax: at(daily.temperature_2m_max, i),
    tempMin: at(daily.temperature_2m_min, i),
    feelsMax: at(daily.apparent_temperature_max, i),
    feelsMin: at(daily.apparent_temperature_min, i),
    precipSum: at(daily.precipitation_sum, i), // mm / 24h
    precipProb: at(daily.precipitation_probability_max, i), // %
    rainSum: at(daily.rain_sum, i),
    showersSum: at(daily.showers_sum, i),
    snowfallSum: at(daily.snowfall_sum, i), // cm
    windMax: at(daily.wind_speed_10m_max, i),
    gustMax: at(daily.wind_gusts_10m_max, i),
    windDir: at(daily.wind_direction_10m_dominant, i),
    uvMax: at(daily.uv_index_max, i),
    sunrise: daily.sunrise?.[i] ?? null,
    sunset: daily.sunset?.[i] ?? null,
  }))

  const hours = []
  if (Array.isArray(hourly?.time)) {
    for (let i = 0; i < hourly.time.length; i++) {
      hours.push({
        time: hourly.time[i],
        date: String(hourly.time[i]).slice(0, 10),
        hour: Number(String(hourly.time[i]).slice(11, 13)),
        temp: at(hourly.temperature_2m, i),
        feels: at(hourly.apparent_temperature, i),
        precip: at(hourly.precipitation, i),
        precipProb: at(hourly.precipitation_probability, i),
        weatherCode: at(hourly.weather_code, i),
        visibility: at(hourly.visibility, i), // m
        gust: at(hourly.wind_gusts_10m, i),
        snowfall: at(hourly.snowfall, i),
      })
    }
  }

  return {
    timezone: json.timezone ?? null,
    days,
    hours,
    current: json.current
      ? {
          time: json.current.time ?? null,
          temp: at([json.current.temperature_2m], 0),
          feels: at([json.current.apparent_temperature], 0),
          humidity: at([json.current.relative_humidity_2m], 0),
          weatherCode: at([json.current.weather_code], 0),
          wind: at([json.current.wind_speed_10m], 0),
          gust: at([json.current.wind_gusts_10m], 0),
        }
      : null,
  }
}
