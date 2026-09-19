/**
 * 闸门的持久化与影子记录：每会话模式表 + 追加式 JSONL 记录。
 *
 * 所有 I/O 失败都被吞掉并降级为默认值 —— 闸门绝不能因为写不了日志而弄坏一次工具调用。
 * @module @dsh-external/dsh-jev/gate-store
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { GateMode } from './judgment.ts'

/** 每会话模式表 + 影子记录。 */
export class GateStore {
  private cache: Record<string, GateMode> | undefined

  /**
   * @param stateFile - 每会话模式的 JSON 文件。
   * @param shadowDir - 影子记录的目录。
   * @param defaultMode - 没有显式设置时的模式。
   * @param shadowPrefix - 影子记录文件名前缀，用来把不同闸门的记录分开。
   */
  constructor(
    private readonly stateFile: string,
    private readonly shadowDir: string,
    private defaultMode: GateMode,
    private readonly shadowPrefix = '',
  ) {}

  /**
   * 改"没有显式设置的会话"用的默认模式。
   * @param mode - 新默认模式。
   */
  setDefaultMode(mode: GateMode): void {
    this.defaultMode = mode
  }

  /** 读一次磁盘并缓存；文件缺失或损坏时按空表处理。 */
  private load(): Record<string, GateMode> {
    if (this.cache !== undefined) return this.cache
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.stateFile, 'utf8'))
      this.cache = parsed !== null && typeof parsed === 'object' ? parsed as Record<string, GateMode> : {}
    } catch {
      this.cache = {} // 首次运行、文件被删、或内容损坏：都退化成"没有任何显式设置"。
    }
    return this.cache
  }

  /**
   * @param sessionId - 会话 ID。
   * @returns 该会话当前的闸门模式。
   */
  mode(sessionId: string): GateMode {
    const table = this.load()
    // '*' 是"没有显式设置的会话"的兜底项；会话自己的设置优先。
    const value = table[sessionId] ?? table['*']
    return value === 'off' || value === 'shadow' || value === 'enforce' ? value : this.defaultMode
  }

  /**
   * 写入一个会话的模式并落盘。
   * @param sessionId - 会话 ID。
   * @param mode - 新模式。
   */
  set(sessionId: string, mode: GateMode): void {
    const table = { ...this.load(), [sessionId]: mode }
    this.cache = table
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true })
      const tmp = this.stateFile + '.tmp'
      writeFileSync(tmp, JSON.stringify(table, null, 2))
      renameSync(tmp, this.stateFile)
    } catch {
      return // 落盘失败只影响持久性，内存里的模式本次仍然生效。
    }
  }

  /** @returns 所有显式设置过的会话模式。 */
  all(): Record<string, GateMode> {
    return { ...this.load() }
  }

  /**
   * 追加一条影子记录。日期分文件，方便按天分析。
   * @param entry - 要记录的字段（必须是可 JSON 序列化的纯数据）。
   */
  record(entry: Record<string, unknown>): void {
    try {
      mkdirSync(this.shadowDir, { recursive: true })
      const day = new Date().toISOString().slice(0, 10)
      appendFileSync(join(this.shadowDir, this.shadowPrefix + 'shadow-' + day + '.jsonl'), JSON.stringify(entry) + '\n')
    } catch {
      return // 记录是研究用途，不能因为写不进去就影响工具调用。
    }
  }
}

/**
 * 裁剪任意值成一段有界的预览文本，避免把完整参数写进影子日志。
 * @param value - 任意值。
 * @param max - 最大字符数。
 * @returns 预览文本。
 */
export function preview(value: unknown, max: number): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  if (text === undefined) text = ''
  return text.length > max ? text.slice(0, max) + '…' : text
}
