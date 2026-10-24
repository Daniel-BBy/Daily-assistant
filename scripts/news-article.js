/**
 * 正文提取。
 *
 * 为什么不能直接 stripTags 整页：抓下来的开头是导航栏
 * （"… - InfoQ 首页 AI会议 hot AI课程 hot AI应用 …"），
 * 把菜单喂给模型等于让它对着菜单写摘要。
 *
 * 策略：只取 <p> 段落，过滤掉过短的行（导航项一般很短），
 * 不够长再退回全文。简单但有效，不需要 DOM 解析库。
 */

import { stripTags, decodeEntities } from './news-sources.js'

export async function fetchPage(url, timeoutMs = 15000) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; dsh-brief/0.1)' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())

  let html = buf.toString('utf8')
  if ((html.match(/\uFFFD/g) || []).length > 20) {
    try { html = new TextDecoder('gbk').decode(buf) } catch { /* 保持 utf8 */ }
  }
  return html
}

/**
 * 从 HTML 里取正文段落。
 * @returns {{ text: string, method: 'paragraphs' | 'fulltext' | 'empty' }}
 */
export function extractMain(html) {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')

  const paragraphs = []
  const re = /<p[^>]*>([\s\S]*?)<\/p>/gi
  let m
  while ((m = re.exec(cleaned)) !== null) {
    const text = stripTags(m[1])
    // 导航/按钮/版权行通常很短；正文段落基本都超过 40 字
    if (text.length >= 40 && !/^(广告|分享|订阅|登录|注册|更多|返回)/.test(text)) {
      paragraphs.push(text)
    }
  }

  const joined = paragraphs.join('\n').trim()
  if (joined.length >= 200) return { text: joined, method: 'paragraphs' }

  const fallback = stripTags(cleaned)
  if (fallback.length >= 200) return { text: fallback, method: 'fulltext' }
  return { text: joined || fallback, method: joined ? 'paragraphs' : 'empty' }
}

/** 取正文开头一段，控制给模型的长度。 */
export function lead(text, limit = 400) {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, limit)
}
