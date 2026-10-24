#!/usr/bin/env node
/**
 * 把网页需要的文件收进 web/，让 web/ 变成可以直接上传的完整站点。
 *
 * 为什么不让页面直接 import ../scripts/*.js：
 *   静态托管只能部署一个目录，跨目录引用会 404。
 * 为什么复制而不是重写 import：
 *   被复制的四个模块之间只互相引用，整体平移后相对路径依旧成立。
 *
 * 只复制"浏览器安全"的模块 —— 带 node: 依赖的（brief.js / courses-cli.js）绝不进来。
 */

import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const WEB = join(ROOT, 'web')

/** 浏览器可直接加载的模块（无 node: 内置依赖）。 */
const LIBRARY = ['courses.js', 'openmeteo.js', 'risks.js', 'render.js']

/** 页面要 fetch 的数据文件。 */
const DATA = [
  ['data/term.json', 'term.json'],
  ['data/brief.config.json', 'brief.config.json'],
  ['course_schedule.csv', 'course_schedule.csv'],
]

async function main() {
  await mkdir(join(WEB, 'lib'), { recursive: true })
  await mkdir(join(WEB, 'data'), { recursive: true })

  for (const name of LIBRARY) {
    await copyFile(join(ROOT, 'scripts', name), join(WEB, 'lib', name))
  }
  for (const [from, to] of DATA) {
    await copyFile(join(ROOT, from), join(WEB, 'data', to))
  }

  // 兜底自检：复制进来的模块不应含 node: 依赖，否则浏览器会在加载时报错
  for (const name of LIBRARY) {
    const text = await readFileText(join(WEB, 'lib', name))
    if (/from 'node:/.test(text)) {
      throw new Error(`${name} 含 node: 依赖，不能被浏览器加载`)
    }
  }

  const files = await readdir(join(WEB, 'lib'))
  const data = await readdir(join(WEB, 'data'))
  console.log(`web/lib  : ${files.join(', ')}`)
  console.log(`web/data : ${data.join(', ')}`)
  console.log('完成。部署时整个 web/ 目录上传即可。')
}

async function readFileText(path) {
  const { readFile } = await import('node:fs/promises')
  return readFile(path, 'utf8')
}

main().catch(error => {
  console.error(`[build:web] ${error.message}`)
  process.exitCode = 1
})
