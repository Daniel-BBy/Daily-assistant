/**
 * DeepSeek 客户端。
 *
 * key 的查找顺序：
 *   1. 环境变量 DEEPSEEK_API_KEY
 *   2. 仓库根目录的 .env（已被 .gitignore 排除）
 *   3. 桌面那份"新建 文本文档.env"（兼容用户最初的放置方式）
 *
 * 任何情况下都不打印 key 本身。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FALLBACK = 'C:/Users/daniel/Desktop/新建 文本文档.env'

export const API_BASE = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'

function parseEnvFile(path) {
  const out = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

/** @returns {string} */
export function loadKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY

  for (const p of [join(ROOT, '.env'), FALLBACK]) {
    if (!existsSync(p)) continue
    const raw = readFileSync(p, 'utf8').trim()
    if (/^sk-[A-Za-z0-9_-]+$/.test(raw)) return raw // 整份文件就是裸 key
    const vars = parseEnvFile(p)
    for (const k of Object.keys(vars)) {
      if (/DEEPSEEK|DEEP_SEEK|API_?KEY/i.test(k) && vars[k]) return vars[k]
    }
  }
  throw new Error('找不到 DeepSeek key：请设置 DEEPSEEK_API_KEY，或在仓库根目录放 .env')
}

/**
 * 一次对话调用。
 * @param {{messages: object[], json?: boolean, model?: string, maxTokens?: number, temperature?: number}} opts
 * @returns {Promise<{content: string, usage: object}>}
 */
export async function chat({ messages, json = false, model = 'deepseek-chat', maxTokens = 2000, temperature = 0.3, timeoutMs = 90000 }) {
  const key = loadKey()
  const body = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  }

  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })

  const text = await res.text()
  if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}: ${text.slice(0, 200)}`)

  const data = JSON.parse(text)
  const content = data.choices?.[0]?.message?.content ?? ''
  return { content, usage: data.usage ?? {} }
}
