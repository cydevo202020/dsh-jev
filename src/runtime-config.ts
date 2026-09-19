/**
 * 运行时配置覆盖：注入路径创建的 entry 配置恒为 `{}`，插件拿不到 cordis.yml 里的 config，
 * 所以额外支持一个 JSON 覆盖文件。每次判定前重读（按 mtime 缓存），改完文件立即生效。
 *
 * 只做顶层浅合并：文件里出现的键整体替换 cordis 配置里的同名键。
 * @module @dsh-external/dsh-jev/runtime-config
 */

import { readFileSync, statSync } from 'node:fs'

let cached: { path: string; mtimeMs: number; size: number; value: Record<string, unknown> } | undefined

/**
 * 读覆盖文件里的键值；按 mtime+size 缓存，内容没变就不重复解析。
 * @param path - 覆盖文件路径；空串直接返回空对象（显式关闭覆盖）。
 * @returns 顶层键值；文件缺失、损坏或不是 JSON 对象时返回空对象。
 */
export function loadOverlay(path: string): Record<string, unknown> {
  if (path.length === 0) return {}
  try {
    const stat = statSync(path)
    if (cached !== undefined && cached.path === path && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.value
    }
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const value = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
    cached = { path, mtimeMs: stat.mtimeMs, size: stat.size, value }
    return value
  } catch {
    return {} // 没有覆盖文件是常态；读不动就完全按 cordis 配置走。
  }
}
