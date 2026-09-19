/**
 * @dsh-external/dsh-jev — 把 TypeSafe Jev（System One 决策模型）接进 DSH。
 *
 * Jev 不是聊天模型：它不生成文本、没有 messages/tools/streaming，只接受一个 state 加一组
 * 带类型的问题，返回结构化答案与概率。所以它替代的不是主 agent 循环，而是那些本该问 LLM
 * 的窄判定。
 *
 * 三条通道：
 * - 工具 \`jev_judge\`：主 agent（ds）把分类/打分/是-否判定外包给 Jev。
 * - 服务 \`jev\`：其它插件或 host 代码直接 \`await ctx.get('jev').ask(...)\`，全程不经过 LLM。
 * - 工具闸门：挂在 \`tools/pre-execute\` 上，按会话开关，影子模式只记录、enforce 模式才真拦。
 * @module @dsh-external/dsh-jev
 */

import type { Context } from 'cordis'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from 'schemastery'
import {
  CU_GATE_QUESTIONS, CU_OBSERVE_LEAVES, cuGateState, cuVerdictOf, GATE_OBSERVE_TOOLS, GATE_QUESTIONS, gateState,
  isGateObserveTool, riskClassOf, scaledTimeoutMs, shapeKeyOf, stableJson, toolLeaf, verdictOf,
  type CuGateAnswers, type GateAnswers, type GateMode, type GatePath, type GateVerdict,
} from './judgment.js'
import {
  escalateTriggerOf, escalationPrompt, ESCALATION_POLICY, parseEscalationDecision, sessionDigest,
  type EscalateMode, type EscalateTrigger, type EscalationOutcome, type JevSummary,
} from './escalate.js'
import { GateStore, preview } from './gate-store.js'
import { loadOverlay } from './runtime-config.js'

/** Cordis 插件名。 */
export const name = '@dsh-external/dsh-jev'
/** 依赖工具注册表。 */
export const inject = ['tools']

const GATE_HOME = join(homedir(), '.dsh', 'jev-gate')

/**
 * 贡献者注册表挂在进程上的键。
 *
 * 热重载会换掉插件实例，而 `ctx.get('jevGate')` 在服务名被上一代占着时仍指向旧实例——
 * 注册表要是实例私有的，新实例就看不到任何贡献者（线上实测：重载闸门后守卫的判定静默消失）。
 * 用 `Symbol.for` 保证同进程内每一代实例拿到同一个表。
 */
const CONTRIBUTOR_REGISTRY_KEY = Symbol.for('@dsh-external/dsh-jev:contributors')

/** 贡献者条目的有效期：活着的贡献者会周期性续期，停掉的自动失效。 */
const CONTRIBUTOR_TTL_MS = 5 * 60_000

/** 归 computer-use / browser-use 闸门管的工具名前缀；命中前缀即命中，全名也按前缀匹配。 */
const CU_TOOL_PREFIXES_DEFAULT = ['cua_driver_native__', 'mcp__cua-driver-mcp__', 'mcp__playwright-mcp__', 'browser_code']

/** 参数里属于敏感内容的键：值替换成占位符后才送给 Jev，密码与卡号不出本机。 */
const CU_REDACT_KEYS_DEFAULT = ['text', 'value', 'prompt_text']

/** 可见性判定的时间预算上限：它挡在首次浏览器调用前面，不能按普通判定的 30s 走。 */
const VISIBILITY_BUDGET_MS = 2_000

/** 问一次"这个会话需不需要看得见的浏览器窗口"。 */
const VISIBILITY_QUESTION: JevQuestion = {
  id: 'visible',
  type: 'noul',
  instructions: 'Should this automated browser session run in a window the user can watch, rather than invisibly? Answer true when a person needs to see or follow along: a demonstration, a manual login or verification step, visual debugging, or an interactive page. Answer false for unattended extraction, scraping, and batch work where nobody is watching.',
  criteria: {
    true: 'A human needs to watch this browser work happen in a window.',
    false: 'Nobody needs to watch; the work is better done invisibly.',
  },
}

/** 一个 Jev 端点：官方、OpenRouter 或自建网关。 */
export interface JevEndpoint {
  /** 诊断与影子日志里用的标签。 */
  label?: string
  /** API 根地址。 */
  baseURL: string
  /** 判定路由；缺省 '/v1/systemone'（TypeSafe 官方）。 */
  path?: string
  /** 从哪个环境变量读取这个端点的 key。 */
  apiKeyEnv: string
  /** 该端点的模型覆盖。 */
  model?: string
}

/** 补齐缺省值之后的端点。 */
interface ResolvedEndpoint {
  label: string
  baseURL: string
  path: string
  apiKeyEnv: string
  model: string
}

/** 插件配置。 */
export interface Config {
  /** 从哪个环境变量读取 API key。 */
  apiKeyEnv: string
  /** 环境变量缺省时，回退到这个 DSH 凭证文件的 refs: 段。 */
  credentialsPath: string
  /** API 根地址。 */
  baseURL: string
  /** 默认模型（别名或版本号）。 */
  model: string
  /** 单次请求超时（毫秒）。 */
  timeoutMs: number
  /** state 字符上限，超出直接报错而不是悄悄截断。 */
  maxStateChars: number
  /** 429/529 的最大重试次数。 */
  maxRetries: number
  /** 没有被显式设置过的会话使用哪种闸门模式。 */
  gateDefaultMode: string
  /** needs_human_approval 超过它即升级给人。 */
  gateAskThreshold: number
  /** needs_human_approval 超过它即直接拒绝；默认 2（永不触发）。 */
  gateDenyThreshold: number
  /** 闸门单次判定超时；超时即放行走既有权限链。 */
  gateTimeoutMs: number
  /** 每会话模式表的落盘路径。 */
  gateStateFile: string
  /** 影子记录目录（按天分文件）。 */
  gateShadowDir: string
  /** 影子记录里参数预览的字符上限。 */
  gatePreviewChars: number
  /** 通用闸门里命中这些工具名即整条跳过判定（只读/自省；只收任何参数下都不改状态的工具）。 */
  gateObserveTools: string[]
  /** 是否启用只读跳过；关掉后连只读调用也判。 */
  gateObserveSkip: boolean
  /** 判定失败时是否对高风险调用改为"问人"；关掉即回到旧行为（一律交回权限链）。 */
  gateFailClosedOnTimeout: boolean
  /** 通用闸门单个字符串参数的截断长度；防止一次大写入把 state 顶过 maxStateChars 而让判定失败。 */
  gateArgChars: number
  /** 形状缓存有效期（毫秒）：同会话里同样的工具+参数直接复用结论。0 关闭。 */
  gateCacheTtlMs: number
  /** 形状缓存的条目上限，超出即整体清空。 */
  gateCacheMax: number
  /** 人工批准过的形状在多久内免问（毫秒）。0 关闭（默认）。 */
  gateApproveOnceTtlMs: number
  /** 放权模式：off 不启用 / shadow 只记录 / enforce 让 LLM 分类器接管处置。 */
  escalateMode: string
  /** 一次放权判定的超时（毫秒）。 */
  escalateTimeoutMs: number
  /** 单个会话最多放权多少次，防止把它变成"每次都问大模型"。 */
  escalateMaxPerSession: number
  /** U2 的余量：判定分数与阈值的距离小于它就算"贴着分数线"。 */
  escalateMargin: number
  /** U1 的置信度门槛：判定器"自信放行"时不放权，避免给标识符型调用白花一次大模型往返。 */
  escalateThinConfidence: number
  /** U4 的低置信阈值。 */
  escalateLowConfidence: number
  /** 是否启用 U4（依赖置信度；实测置信度没有区分力，默认关闭）。 */
  escalateEnableLowConfidence: boolean
  /** 放权请求里参数部分的字符上限。 */
  escalateArgChars: number
  /** 额外的 Jev 端点，按顺序回退；留空时只用 baseURL/apiKeyEnv/model 描述的官方端点。 */
  endpoints: JevEndpoint[]
  /** 是否启用 computer-use / browser-use 专用闸门。 */
  cuGateEnabled: boolean
  /** 命中这些前缀（或全名）的工具归 CU/BU 闸门管。 */
  cuToolPrefixes: string[]
  /** 叶子名命中这里的 CU/BU 工具属于纯观察，不做判定，避免给每次快照加一次网络往返。 */
  cuObserveLeaves: string[]
  /** 参数里哪些键的值属于敏感内容，替换成占位符后才送给 Jev。 */
  cuRedactKeys: string[]
  /** 单个字符串参数的截断长度，避免一个长脚本把 state 顶爆。 */
  cuArgChars: number
  /** 没有显式设置过的会话使用哪种 CU 闸门模式。 */
  cuGateDefaultMode: string
  /** CU 闸门：needs_human_approval 超过它即升级给人。 */
  cuGateAskThreshold: number
  /** CU 闸门：needs_human_approval 超过它即直接拒绝；默认 2（永不触发）。 */
  cuGateDenyThreshold: number
  /** CU 闸门单次判定超时。 */
  cuGateTimeoutMs: number
  /** CU 闸门每会话模式表的落盘路径。 */
  cuGateStateFile: string
  /** 运行时覆盖文件；顶层键浅合并到上面的配置，改完立即生效。空串关闭覆盖。 */
  runtimeConfigFile: string
  /** 是否提供 browserVisibility 服务：会话首次浏览器调用前问一次 Jev 要不要可见窗口。 */
  browserVisibilityEnabled: boolean
}

export const Config = z.object({
  apiKeyEnv: z.string().default('TYPESAFE_API_KEY'),
  credentialsPath: z.string().default(join(homedir(), '.dsh', '.credentials.yaml')),
  baseURL: z.string().default('https://api.typesafe.ai'),
  model: z.string().default('jev-latest'),
  timeoutMs: z.number().step(1).min(1000).default(30_000),
  maxStateChars: z.number().step(1).min(1000).default(40_000),
  maxRetries: z.number().step(1).min(0).max(5).default(2),
  gateDefaultMode: z.string().default('off'),
  gateAskThreshold: z.number().default(0.5),
  gateDenyThreshold: z.number().default(2),
  gateTimeoutMs: z.number().step(1).min(500).default(8000),
  gateStateFile: z.string().default(join(GATE_HOME, 'state.json')),
  gateShadowDir: z.string().default(GATE_HOME),
  gatePreviewChars: z.number().step(1).min(0).default(300),
  gateObserveTools: z.array(z.string()).default([...GATE_OBSERVE_TOOLS]),
  gateObserveSkip: z.boolean().default(true),
  gateFailClosedOnTimeout: z.boolean().default(true),
  gateArgChars: z.number().step(1).min(200).default(2000),
  gateCacheTtlMs: z.number().step(1).min(0).default(60_000),
  gateCacheMax: z.number().step(1).min(1).default(256),
  gateApproveOnceTtlMs: z.number().step(1).min(0).default(0),
  escalateMode: z.string().default('shadow'),
  escalateTimeoutMs: z.number().step(1).min(500).default(8000),
  escalateMaxPerSession: z.number().step(1).min(0).default(40),
  escalateMargin: z.number().min(0).max(0.5).default(0.1),
  escalateThinConfidence: z.number().min(0).max(1).default(0.8),
  escalateLowConfidence: z.number().min(0).max(1).default(0.5),
  escalateEnableLowConfidence: z.boolean().default(false),
  escalateArgChars: z.number().step(1).min(200).default(4000),
  endpoints: z.array(z.object({
    label: z.string().default(''),
    baseURL: z.string().default(''),
    path: z.string().default(''),
    apiKeyEnv: z.string().default(''),
    model: z.string().default(''),
  })).default([]),
  cuGateEnabled: z.boolean().default(true),
  cuToolPrefixes: z.array(z.string()).default([...CU_TOOL_PREFIXES_DEFAULT]),
  cuObserveLeaves: z.array(z.string()).default([...CU_OBSERVE_LEAVES]),
  cuRedactKeys: z.array(z.string()).default([...CU_REDACT_KEYS_DEFAULT]),
  cuArgChars: z.number().step(1).min(50).default(600),
  cuGateDefaultMode: z.string().default('shadow'),
  cuGateAskThreshold: z.number().default(0.5),
  cuGateDenyThreshold: z.number().default(2),
  cuGateTimeoutMs: z.number().step(1).min(500).default(8000),
  cuGateStateFile: z.string().default(join(GATE_HOME, 'cu-state.json')),
  runtimeConfigFile: z.string().default(join(GATE_HOME, 'config.json')),
  browserVisibilityEnabled: z.boolean().default(true),
})

/** 一个 yes/no 问题：返回答案取值为 1 的概率。 */
export interface JevNoulQuestion {
  /** 答案在响应里的键。 */
  id: string
  type: 'noul'
  /** 要判定的陈述或问题。 */
  instructions: string
  /** 可选：说明 yes / no 各代表什么。 */
  criteria?: { true?: string; false?: string }
}

/** 一个多选一问题：从你给的选项里选一个。 */
export interface JevChoiceQuestion {
  id: string
  type: 'choice'
  instructions: string
  /** 选项到说明的映射；不需要额外说明时给 null。 */
  criteria: Record<string, string | null>
}

/** 一个打分问题：按你给的有序等级打分。 */
export interface JevScoreQuestion {
  id: string
  type: 'score'
  instructions: string
  /** 有序等级，至少两级。 */
  criteria: string[]
}

/** 三种问题之一。 */
export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion

/** noul 答案。 */
export interface JevNoulAnswer {
  type: 'noul'
  /** 0（否）到 1（是）。 */
  noul: number
}

/** choice 答案。 */
export interface JevChoiceAnswer {
  type: 'choice'
  /** 概率最高的选项。 */
  choice: string
  /** 每个选项的概率，和为 1。 */
  probabilities: Record<string, number>
  /** 由概率分布导出的确信度 0 到 1。 */
  confidence: number
}

/** score 答案。 */
export interface JevScoreAnswer {
  type: 'score'
  /** 概率加权后的分数，可能落在两级之间。 */
  score: number
  /** 等级序号的字符串键到等级描述。 */
  legend: Record<string, string>
  probabilities: Record<string, number>
  confidence: number
}

/** 三种答案之一。 */
export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer

/** 一次 /v1/systemone 调用的结果。 */
export interface JevResult {
  /** 实际作答的模型 ID（别名会被解析成版本号）。 */
  model: string
  /** 与问题 id 一一对应。 */
  answers: Record<string, JevAnswer>
  usage: { input_tokens: number; output_tokens: number }
  /** 实际作答的端点标签；本地构造的结果没有这个字段。 */
  endpoint?: string
}

/** 暴露给其它插件的服务。 */
export interface JevService {
  /** 是否已找到 API key（不含校验，校验要发请求才知道）。 */
  available(): Promise<boolean>
  /** 用给定的 state 提问，返回结构化答案。 */
  ask(state: unknown, questions: JevQuestion[], options?: { model?: string; signal?: AbortSignal }): Promise<JevResult>
}

/** 贡献者看到的一次待判调用。 */
export interface GateContributionInput {
  /** 工具名。 */
  readonly name: string
  /** 工具参数。 */
  readonly arguments: unknown
  /** 非空表示这是 PTC 包装器内部的子调用。 */
  readonly parent?: unknown
  readonly agent?: { readonly session?: unknown }
  readonly callId?: unknown
}

/** 贡献者给出的处置。 */
export interface ContributorVerdict {
  kind: 'pass' | 'ask' | 'deny'
  /** 一句可读理由，会带上贡献者 id 前缀。 */
  reason: string
  /** true = 按贡献者自己的模式应当生效；false = 它只在影子模式观察。 */
  effective: boolean
}

/** 贡献者向同一次判定追加的内容。 */
export interface GateContribution {
  /** 追加的问题；与闸门自己的问题在同一次调用里问完。 */
  questions: JevQuestion[]
  /** 追加进 state 的顶层字段（例如冻结简报）。 */
  state?: Record<string, unknown>
  /**
   * 拿到答案后得出自己的处置。判定失败时 failure 非空，贡献者应当照常记流水但不给结论。
   * @param answers - 本次调用的原始答案表。
   * @param failure - 判定失败的原因；成功时为 undefined。
   * @returns 处置；不参与或无法判定时返回 undefined。
   */
  settle(answers: Record<string, JevAnswer>, failure?: string): ContributorVerdict | undefined
}

/**
 * 闸门服务：让其它插件把自己的判定挂进同一次 Jev 调用。
 *
 * 存在的理由：两个插件各挂一个 `tools/pre-execute` 监听时，一次通过的工具调用要付两次
 * 网络往返。把问题合并进一次调用不额外增加时延（多选题是并行求值的），也少一次 state 传输。
 */
export interface JevGateService {
  /**
   * 注册一个贡献者。
   * @param id - 唯一标识，用于日志与前缀。
   * @param factory - 每次调用执行一次；返回 undefined 表示这次不参与。
   * @returns 注销函数。
   */
  contribute(id: string, factory: (input: GateContributionInput) => GateContribution | undefined): () => void
}

/**
 * DSH credentials 服务的最小结构。用结构化类型而不是 import：本插件不硬依赖
 * credentials 包，服务缺席时自动回退到环境变量与凭证文件。
 */
interface CredentialsLike {
  resolve(ref: unknown): Promise<{ value: string } | undefined>
}

/** 判定请求里可直接作为 state 的内容类型。 */
type StateInput = string | number | boolean | null | StateInput[] | { [key: string]: StateInput }

/** \`tools/pre-execute\` 上我们真正用到的字段。用结构化类型避免耦合到 harness 内部类型。 */
interface GateExec {
  readonly name: string
  readonly arguments: unknown
  readonly parent?: unknown
  readonly callId?: unknown
  readonly signal: AbortSignal
  readonly agent?: { readonly session?: unknown }
}

/** \`tools/pre-execute\` 允许的返回值。 */
type GateDecision =
  | { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'cancel' } | { kind: 'ask'; reason?: string }

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/**
 * 从 DSH 凭证文件的 refs: 段读一个键。
 * @param path - 例如 ~/.dsh/.credentials.yaml。
 * @param key - 要读的键名。
 * @returns 找到的值；文件缺失、无 refs: 段或键不存在时返回 undefined。
 */
function readCredentialRef(path: string, key: string): string | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined // 凭证文件不存在是正常情况：key 通常直接放在环境变量里。
  }
  let inRefs = false
  for (const line of raw.split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) {
      inRefs = true
      continue
    }
    if (!inRefs) continue
    if (line.trim() === '' || /^#/.test(line.trim())) continue
    if (!/^\s/.test(line)) break // 退回顶层键，refs 段结束。
    const match = /^\s+([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line)
    if (match === null) continue
    if (match[1] !== key) continue
    const value = match[2].trim().replace(/^['"]|['"]$/g, '')
    return value === '' ? undefined : value
  }
  return undefined
}

/**
 * 把非 2xx 响应翻成人类可读的失败原因。
 * @param status - HTTP 状态码。
 * @param body - 响应体（已截断）。
 * @returns 失败原因。
 */
function explainStatus(status: number, body: string): string {
  if (status === 401 || status === 403) {
    return 'API key 缺失或无效，或账号尚未开通计费（TypeSafe 早期访问需要付费后才能调用）。'
  }
  if (status === 422) return '请求体校验失败（检查 questions 的 type 与 criteria）：' + body
  if (status === 429 || status === 529) return '被限流或服务过载（HTTP ' + String(status) + '）。'
  return 'HTTP ' + String(status) + '：' + body
}

/**
 * 组装请求体：把 {id, type, instructions, criteria} 数组折成 TypeSafe 要的 map。
 * @param state - 待判定的内容。
 * @param questions - 问题数组。
 * @param model - 模型 ID 或别名。
 * @returns API 请求体。
 */
function buildBody(state: StateInput, questions: JevQuestion[], model: string): Record<string, unknown> {
  const map: Record<string, unknown> = {}
  for (const question of questions) {
    if (map[question.id] !== undefined) throw new Error('questions 里有重复 id：' + question.id)
    const entry: Record<string, unknown> = { type: question.type, instructions: question.instructions }
    if (question.criteria !== undefined) entry.criteria = question.criteria
    map[question.id] = entry
  }
  return { state, model, questions: map }
}

/**
 * 把闸门问题集折成 ask() 要的数组形式。
 * @returns 三个闸门问题。
 */
function gateQuestionList(): JevQuestion[] {
  const list: JevQuestion[] = []
  for (const [id, q] of Object.entries(GATE_QUESTIONS)) {
    if (q.type === 'choice') list.push({ id, type: 'choice', instructions: q.instructions, criteria: q.criteria })
    else list.push({ id, type: 'noul', instructions: q.instructions, criteria: q.criteria })
  }
  return list
}

/**
 * 把 CU/BU 问题集折成 ask() 要的数组形式。
 * @returns 五个 CU/BU 闸门问题。
 */
function cuQuestionList(): JevQuestion[] {
  const q = CU_GATE_QUESTIONS
  return [
    { id: 'action_kind', type: 'choice', instructions: q.action_kind.instructions, criteria: q.action_kind.criteria },
    { id: 'reversibility', type: 'score', instructions: q.reversibility.instructions, criteria: q.reversibility.criteria },
    { id: 'touches_credentials', type: 'noul', instructions: q.touches_credentials.instructions, criteria: q.touches_credentials.criteria },
    { id: 'sensitive_surface', type: 'noul', instructions: q.sensitive_surface.instructions, criteria: q.sensitive_surface.criteria },
    { id: 'needs_human_approval', type: 'noul', instructions: q.needs_human_approval.instructions, criteria: q.needs_human_approval.criteria },
  ]
}

/**
 * 从原始答案里取出闸门需要的三个字段；缺任何一个就返回 undefined（当作判定失败）。
 * @param answers - Jev 返回的 answers。
 * @returns 结构化后的闸门答案。
 */
function toGateAnswers(answers: Record<string, JevAnswer>): GateAnswers | undefined {
  const effect = answers['effect']
  const outside = answers['touches_outside_project']
  const approval = answers['needs_human_approval']
  if (effect?.type !== 'choice' || outside?.type !== 'noul' || approval?.type !== 'noul') return undefined
  return {
    effect: { choice: effect.choice, confidence: effect.confidence, probabilities: effect.probabilities },
    touches_outside_project: { noul: outside.noul },
    needs_human_approval: { noul: approval.noul },
  }
}

/**
 * 从原始答案里取出 CU/BU 闸门需要的五个字段；缺任何一个就返回 undefined（当作判定失败）。
 * @param answers - Jev 返回的 answers。
 * @returns 结构化后的 CU/BU 闸门答案。
 */
function toCuAnswers(answers: Record<string, JevAnswer>): CuGateAnswers | undefined {
  const kind = answers['action_kind']
  const reversibility = answers['reversibility']
  const credentials = answers['touches_credentials']
  const sensitive = answers['sensitive_surface']
  const approval = answers['needs_human_approval']
  if (kind?.type !== 'choice' || reversibility?.type !== 'score' || credentials?.type !== 'noul'
    || sensitive?.type !== 'noul' || approval?.type !== 'noul') return undefined
  return {
    action_kind: { choice: kind.choice, confidence: kind.confidence, probabilities: kind.probabilities },
    reversibility: { score: reversibility.score, confidence: reversibility.confidence },
    touches_credentials: { noul: credentials.noul },
    sensitive_surface: { noul: sensitive.noul },
    needs_human_approval: { noul: approval.noul },
  }
}

/**
 * 从会话对象上尽力取一个稳定 ID 与工作目录。会话对象是 harness 内部类型，这里只做结构读取。
 * @param session - \`exec.agent.session\`。
 * @returns 可用的 ID 与 cwd，取不到就是 undefined。
 */
function sessionFacts(session: unknown): { id?: string; cwd?: string } {
  if (session === null || typeof session !== 'object') return {}
  const record = session as Record<string, unknown>
  const rawId = record['id']
  const header = record['header']
  const rawCwd = header !== null && typeof header === 'object' ? (header as Record<string, unknown>)['cwd'] : undefined
  return {
    ...rawId === undefined || rawId === null ? {} : { id: String(rawId) },
    ...typeof rawCwd === 'string' && rawCwd.length > 0 ? { cwd: rawCwd } : {},
  }
}

/**
 * 从事件数据里抽出文本部分。结构不符就返回 undefined，由调用方回落。
 * @param data - `user/message` 事件的数据段。
 * @returns 拼接后的文本；没有文本部分时为 undefined。
 */
function messageText(data: unknown): string | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const record = data as Record<string, unknown>
  const message = record['message']
  const content = message !== null && typeof message === 'object'
    ? (message as Record<string, unknown>)['content']
    : record['content']
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue
    const text = (part as Record<string, unknown>)['text']
    if (typeof text === 'string') parts.push(text)
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

/**
 * 从会话日志往回找最近一条用户消息的文本。
 *
 * 只做结构读取：`eventAt`/`seq` 形状不符就返回 undefined，让调用方按"不可见"回落。
 * 扫描有界，避免长会话在这里线性变慢。
 * @param session - `agent.session`。
 * @returns 用户最近一次请求的文本；取不到时为 undefined。
 */
function latestUserTask(session: unknown): string | undefined {
  if (session === null || typeof session !== 'object') return undefined
  const record = session as Record<string, unknown>
  const eventAt = record['eventAt']
  const seq = record['seq']
  if (typeof eventAt !== 'function' || typeof seq !== 'number') return undefined
  const read = eventAt as (at: unknown) => unknown
  for (let at = seq - 1, scanned = 0; at >= 0 && scanned < 200; at--, scanned++) {
    const event = read.call(session, at)
    if (event === null || typeof event !== 'object') continue
    const typed = event as Record<string, unknown>
    if (typed['type'] !== 'user/message') continue
    const text = messageText(typed['data'])
    return text !== undefined && text.length > 2_000 ? text.slice(0, 2_000) : text
  }
  return undefined
}

/** @param agent - `browserVisibility` 调用方给的 agent。 @returns 它的会话对象，取不到就是 undefined。 */
function sessionOf(agent: unknown): unknown {
  return agent !== null && typeof agent === 'object' ? (agent as Record<string, unknown>)['session'] : undefined
}

/**
 * 注册 jev_judge / jev_gate 工具、jev 服务与工具闸门。
 * @param ctx - 插件上下文，tools 已注入。
 * @param config - 解析后的插件配置。
 */
export function apply(ctx: Context, config: Config): void {
  try {
    applyGate(ctx, config)
  } catch (error) {
    // fiber 加载失败时 harness 只标 [failed]，堆栈在注入器返回里看不到；落一份到闸门目录。
    try {
      mkdirSync(GATE_HOME, { recursive: true })
      appendFileSync(join(GATE_HOME, 'load-error.log'),
        new Date().toISOString() + ' ' + (error instanceof Error ? (error.stack ?? error.message) : String(error)) + '\n')
    } catch {
      // 诊断文件写不进去不算错误：原异常继续往上抛。
    }
    throw error
  }
}

/**
 * 闸门装配主体；外面那层 try 只负责把加载期异常落盘。
 * @param ctx - 插件上下文。
 * @param config - 插件配置。
 */
function applyGate(ctx: Context, config: Config): void {
  const store = new GateStore(config.gateStateFile, config.gateShadowDir, config.gateDefaultMode as GateMode)
  const cuStore = new GateStore(
    config.cuGateStateFile ?? join(GATE_HOME, 'cu-state.json'),
    config.gateShadowDir,
    (config.cuGateDefaultMode ?? 'shadow') as GateMode,
    'cu-',
  )
  const gateQuestions = gateQuestionList()
  const cuQuestions = cuQuestionList()
  let cuGateOn = true
  let cuPrefixes: readonly string[] = CU_TOOL_PREFIXES_DEFAULT
  let observeLeaves: readonly string[] = CU_OBSERVE_LEAVES
  let cuRedactKeys: readonly string[] = CU_REDACT_KEYS_DEFAULT
  let cuArgChars = 600

  /** 从当前配置重算可派生取值（含两个闸门的默认模式）。 */
  const syncKnobs = (): void => {
    cuGateOn = config.cuGateEnabled !== false
    cuPrefixes = config.cuToolPrefixes ?? CU_TOOL_PREFIXES_DEFAULT
    observeLeaves = config.cuObserveLeaves ?? CU_OBSERVE_LEAVES
    cuRedactKeys = config.cuRedactKeys ?? CU_REDACT_KEYS_DEFAULT
    cuArgChars = config.cuArgChars ?? 600
    store.setDefaultMode(config.gateDefaultMode as GateMode)
    cuStore.setDefaultMode((config.cuGateDefaultMode ?? 'shadow') as GateMode)
  }

  /**
   * 重读运行时覆盖文件并浅合并进配置，然后重算派生取值。
   *
   * 注入路径建的 entry 配置恒为 `{}`，cordis.yml 里的 config 到不了这里，所以这是
   * 注入态下唯一的配置入口：改 `runtimeConfigFile` 立即生效，不必热重载。
   */
  const baseConfig = { ...config }
  let overlaidKeys: string[] = []
  const refreshConfig = (): void => {
    const overlayPath = config.runtimeConfigFile ?? ''
    const overlay = loadOverlay(overlayPath)
    const target = config as unknown as Record<string, unknown>
    // 上一轮被覆盖、这一轮已从文件里删掉的键：退回基准值，避免删键后仍留着旧覆盖。
    for (const key of overlaidKeys) {
      if (overlay[key] === undefined) target[key] = (baseConfig as unknown as Record<string, unknown>)[key]
    }
    for (const [key, value] of Object.entries(overlay)) target[key] = value
    overlaidKeys = Object.keys(overlay)
    syncKnobs()
  }

  syncKnobs()
  refreshConfig()
  const inCuFamily = (toolName: string): boolean => cuPrefixes.some((prefix) => toolName.startsWith(prefix))
  const isCuObserve = (toolName: string): boolean => observeLeaves.includes(toolLeaf(toolName))

  // ── 形状缓存与"人工批准过的形状"记忆 ──────────────────────────────────────
  // 键 = 会话 + 工具名 + 参数（键序稳定）。同一形状的结论必然相同，可以直接复用。
  const shapeCache = new Map<string, { at: number; verdict: GateVerdict }>()
  const pendingShapes = new Map<string, { shape: string; at: number }>()
  const approvedShapes = new Map<string, number>()

  // ── 判定贡献者：其它插件把问题挂进同一次调用 ──────────────────────────────
  // 注册表挂在进程级：热重载会换掉插件实例，而 ctx.get('jevGate') 在这个环境下可能仍指向
  // 上一代实例的服务对象——表要是实例私有的，新实例就看不到任何贡献者，守卫插件的判定会
  // 静默消失（2026-09-19 线上实测）。条目带时间戳：活着的贡献者会周期性续期，停掉的自动失效。
  const contributorFactories = (() => {
    const holder = globalThis as unknown as Record<symbol, unknown>
    const existing = holder[CONTRIBUTOR_REGISTRY_KEY]
    if (existing instanceof Map) {
      return existing as Map<string, { factory: (input: GateContributionInput) => GateContribution | undefined; at: number }>
    }
    const created = new Map<string, { factory: (input: GateContributionInput) => GateContribution | undefined; at: number }>()
    holder[CONTRIBUTOR_REGISTRY_KEY] = created
    return created
  })()
  const CONTRIBUTION_RANK = { pass: 0, ask: 1, deny: 2 } as const

  /**
   * 收集本次调用愿意参与的贡献者。
   * 某个贡献者抛错只丢它自己 —— 闸门不能因为别人的 bug 停摆。
   * @param exec - 待判调用。
   * @returns 参与本次判定的贡献者。
   */
  const collectContributions = (exec: GateExec): { id: string; questions: JevQuestion[]; state?: Record<string, unknown>; settle: GateContribution['settle'] }[] => {
    if (contributorFactories.size === 0) return []
    const input: GateContributionInput = {
      name: exec.name,
      arguments: exec.arguments,
      ...exec.parent === undefined ? {} : { parent: exec.parent },
      ...exec.agent === undefined ? {} : { agent: exec.agent },
      ...exec.callId === undefined ? {} : { callId: exec.callId },
    }
    const out: { id: string; questions: JevQuestion[]; state?: Record<string, unknown>; settle: GateContribution['settle'] }[] = []
    for (const [id, entry] of contributorFactories) {
      if (Date.now() - entry.at > CONTRIBUTOR_TTL_MS) {
        contributorFactories.delete(id) // 贡献者已经不在了：让它过期，别用旧规则继续管事。
        continue
      }
      try {
        const contribution = entry.factory(input)
        if (contribution === undefined || contribution.questions.length === 0) continue
        out.push({
          id,
          questions: contribution.questions,
          ...contribution.state === undefined ? {} : { state: contribution.state },
          settle: contribution.settle,
        })
      } catch {
        continue // 贡献者自己的异常：跳过它，闸门继续。
      }
    }
    return out
  }

  /**
   * 让贡献者结算，并把它自己的模式翻译成处置。
   * @param id - 贡献者 id。
   * @param settle - 贡献者的结算函数。
   * @param answers - 原始答案表；判定失败时为 undefined。
   * @param failure - 判定失败原因。
   * @returns 处置；贡献者抛错或不给结论时为 undefined。
   */
  const safeSettle = (
    id: string,
    settle: GateContribution['settle'],
    answers: Record<string, JevAnswer> | undefined,
    failure: string | undefined,
  ): { id: string; verdict: ContributorVerdict } | undefined => {
    try {
      const verdict = settle(answers ?? {}, failure)
      return verdict === undefined ? undefined : { id, verdict }
    } catch {
      return undefined // 同上：不影响闸门自身的结论。
    }
  }

  /**
   * 把闸门自己的结论与各贡献者的结论合并：最严的赢（deny > ask > pass）。
   * 只记录不生效的贡献者（自己的模式是 shadow）不参与合并。
   * @param gate - 闸门自己的结论。
   * @param settled - 已结算的贡献者。
   * @returns 合并后的结论。
   */
  const foldContributions = (
    gate: GateVerdict | undefined,
    settled: { id: string; verdict: ContributorVerdict }[],
  ): GateVerdict | undefined => {
    let best = gate
    for (const item of settled) {
      if (!item.verdict.effective) continue
      if (best === undefined || CONTRIBUTION_RANK[item.verdict.kind] > CONTRIBUTION_RANK[best.kind]) {
        best = { kind: item.verdict.kind, reason: '[contributor ' + item.id + '] ' + item.verdict.reason }
      }
    }
    return best
  }

  /**
   * 三张表的兜底：先丢过期项，再按上限丢最旧的。
   * 没有这一步，长时间运行的进程里它们只会一直涨（每个会话都在往里塞）。
   * @param map - 要收敛的表。
   * @param max - 条目上限。
   * @param isExpired - 判定某个值是否已经过期。
   */
  const boundMap = <V>(map: Map<string, V>, max: number, isExpired: (value: V) => boolean): void => {
    for (const [key, value] of map) if (isExpired(value)) map.delete(key)
    while (map.size > max) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }

  /** 查形状缓存；过期即删。 */
  const cachedVerdict = (shape: string): GateVerdict | undefined => {
    // 默认与 Config schema 一致：注入态下 schema 不一定会跑，这里兜住默认值。
    const ttl = config.gateCacheTtlMs ?? 60_000
    if (ttl <= 0) return undefined
    const hit = shapeCache.get(shape)
    if (hit === undefined) return undefined
    if (Date.now() - hit.at > ttl) {
      shapeCache.delete(shape)
      return undefined
    }
    return hit.verdict
  }

  /** 这个形状是否在有效期内被人工批准过。 */
  const approvedRecently = (shape: string): boolean => {
    const ttl = config.gateApproveOnceTtlMs ?? 0
    if (ttl <= 0) return false
    const at = approvedShapes.get(shape)
    return at !== undefined && Date.now() - at <= ttl
  }

  /** 记下结论；结论是 ask 时同时挂起"等这次调用真的执行了就算批准"。 */
  const rememberVerdict = (shape: string, verdict: GateVerdict, callId: unknown): void => {
    if ((config.gateCacheTtlMs ?? 60_000) > 0) {
      if (shapeCache.size >= (config.gateCacheMax ?? 256)) shapeCache.clear()
      shapeCache.set(shape, { at: Date.now(), verdict })
    }
    if (verdict.kind === 'ask' && callId !== undefined && callId !== null) {
      pendingShapes.set(String(callId), { shape, at: Date.now() })
      boundMap(pendingShapes, 256, (value) => Date.now() - value.at > 600_000)
    }
  }

  // ── 放权：判定器糊涂时，把决定权交给带完整上下文的 LLM 分类器 ──────────────
  const escalateCounts = new Map<string, number>()

  /**
   * 从会话头里取本次请求实际使用的模型路由。
   *
   * llm 服务需要 provider/model 才知道把请求发给谁；不给的话流会直接结束且没有任何内容
   * （实测：chunks=1、文本为空）。取不到就返回空对象，交给 llm 服务的默认路由。
   * @param session - agent.session。
   * @returns provider 与 model（可能只有其中一个，也可能都缺）。
   */
  const routeOf = (session: unknown): { provider?: string; model?: string } => {
    if (session === null || typeof session !== 'object') return {}
    const record = session as Record<string, unknown>
    const requestHeader = record['requestHeader']
    if (typeof requestHeader !== 'function') return {}
    try {
      const header = (requestHeader as () => unknown).call(session)
      const config = header !== null && typeof header === 'object' ? (header as Record<string, unknown>)['config'] : undefined
      if (config === null || typeof config !== 'object') return {}
      const provider = (config as Record<string, unknown>)['provider']
      const model = (config as Record<string, unknown>)['model']
      return {
        ...typeof provider === 'string' && provider.length > 0 ? { provider } : {},
        ...typeof model === 'string' && model.length > 0 ? { model } : {},
      }
    } catch {
      return {} // 会话对象形状变了：退回默认路由，不影响放权本身。
    }
  }

  /**
   * 跑一次放权判定。
   *
   * 三种失败都不影响工具调用：没配 llm 服务、超过会话预算、模型没按协议作答——
   * 一律只记一条，处置仍然按原路径走。
   * @param exec - 待判调用。
   * @param session - agent.session，用来取上下文。
   * @param facts - 会话 id 与工作目录。
   * @param trigger - 触发条件。
   * @param summary - 判定器的结论摘要。
   * @returns 放权结果；模式为 off 时返回 undefined。
   */
  const runEscalation = async (
    exec: GateExec,
    session: unknown,
    facts: { id?: string; cwd?: string },
    trigger: EscalateTrigger,
    summary: JevSummary,
  ): Promise<EscalationOutcome | undefined> => {
    const mode = (config.escalateMode ?? 'shadow') as EscalateMode
    if (mode === 'off') return undefined
    const llm = ctx.get('llm') as { stream?: (options: unknown) => AsyncIterable<unknown> } | undefined
    if (llm === undefined || typeof llm.stream !== 'function') {
      return { trigger, mode, ms: 0, error: 'llm 服务不可用' }
    }
    const key = facts.id ?? 'unknown'
    const cap = config.escalateMaxPerSession ?? 40
    const used = escalateCounts.get(key) ?? 0
    if (used >= cap) return { trigger, mode, ms: 0, error: '本会话放权次数已达上限 ' + String(cap) }
    escalateCounts.set(key, used + 1)
    if (escalateCounts.size > 256) {
      const oldest = escalateCounts.keys().next().value
      if (oldest !== undefined) escalateCounts.delete(oldest)
    }

    const timeoutMs = config.escalateTimeoutMs ?? 8000
    const started = Date.now()
    try {
      const prompt = escalationPrompt({
        tool: exec.name,
        args: exec.arguments,
        ...facts.cwd === undefined ? {} : { cwd: facts.cwd },
        trigger,
        jevSummary: summary,
        digest: sessionDigest(session),
        maxArgChars: config.escalateArgChars ?? 4000,
      })
      // 这里不 import @deepseek-ai/dsh-llm 的 createUserMessage：运行时注入的插件
      // 解析裸模块走 profile 的 node_modules，那里没有这个包，引用它会让整个插件
      // 加载失败（实测 dev_inject_plugin 返回 host ✗）。消息结构本来就是
      // {id, role, content, source}，自己构造即可，少一个运行时依赖。
      const messages = [{
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin', plugin: name },
      }]
      let text = ''
      let chunks = 0
      const stream = llm.stream({
        ...routeOf(session),
        system: ESCALATION_POLICY,
        messages,
        temperature: 0,
        signal: AbortSignal.timeout(timeoutMs),
      })
      for await (const chunk of stream) {
        chunks++
        const piece = chunk as { type?: unknown; text?: unknown }
        if (piece.type === 'finish') break
        if (piece.type === 'text-delta' && typeof piece.text === 'string') text += piece.text
      }
      const parsed = parseEscalationDecision(text)
      if (parsed === undefined) {
        // 把"收到了什么"一起记下来：协议不符和"模型什么都没说"是两种完全不同的故障。
        return {
          trigger, mode, ms: Date.now() - started, error: '模型输出不符合协议',
          chunks, sample: text.slice(0, 200),
        }
      }
      return {
        trigger, mode, ms: Date.now() - started,
        decision: parsed.decision,
        ...parsed.risk === undefined ? {} : { risk: parsed.risk },
        ...parsed.reason === undefined ? {} : { reason: parsed.reason },
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      return { trigger, mode, ms: Date.now() - started, error: message.slice(0, 200) }
    }
  }

  const resolveKey = async (envName: string): Promise<string | undefined> => {
    const credentials = ctx.get('credentials') as CredentialsLike | undefined
    if (credentials !== undefined) {
      const hit = await credentials.resolve(envName)
      if (hit !== undefined && hit.value.length > 0) return hit.value
    }
    const ambient = process.env[envName]
    if (ambient !== undefined && ambient.length > 0) return ambient
    return readCredentialRef(config.credentialsPath, envName)
  }

  /**
   * 按顺序展开要尝试的端点。没有显式配 endpoints 时退化成"官方端点一个"，
   * 行为与单端点版本完全一致。
   * @returns 已补齐缺省值的端点列表。
   */
  const endpointsOf = (): ResolvedEndpoint[] => {
    const configured = config.endpoints ?? []
    if (configured.length === 0) {
      return [{ label: 'typesafe', baseURL: config.baseURL, path: '/v1/systemone', apiKeyEnv: config.apiKeyEnv, model: config.model }]
    }
    return configured.map((entry, index) => ({
      label: entry.label !== undefined && entry.label !== '' ? entry.label : 'endpoint-' + String(index + 1),
      baseURL: entry.baseURL,
      path: entry.path !== undefined && entry.path !== '' ? entry.path : '/v1/systemone',
      apiKeyEnv: entry.apiKeyEnv,
      model: entry.model !== undefined && entry.model !== '' ? entry.model : config.model,
    }))
  }

  // 闸门在每次工具调用前都会跑；把"有没有 key"缓存 60 秒，避免没配 key 时每次都重读凭证文件。
  let keyCache: { at: number; ok: boolean } | undefined
  const anyEndpointUsable = async (): Promise<boolean> => {
    if (keyCache !== undefined && Date.now() - keyCache.at < 60_000) return keyCache.ok
    let ok = false
    for (const endpoint of endpointsOf()) {
      if ((await resolveKey(endpoint.apiKeyEnv)) !== undefined) {
        ok = true
        break
      }
    }
    keyCache = { at: Date.now(), ok }
    return ok
  }

  /**
   * 依次尝试每个端点，任一端点成功即返回。
   *
   * 官方额度耗尽（402/403/429）、限流、网络故障都只是换下一个端点的理由：把 OpenRouter
   * 这类备选配在后面，官方月度余额不足时判定仍然继续。所有端点都失败才抛错，错误里带
   * 每个端点的失败原因，便于判断是 key 缺失还是额度问题。
   * @param state - 待判定内容。
   * @param questions - 问题集。
   * @param options - 模型覆盖、外部取消信号，以及整条端点链路的预算。
   * @returns 判定结果，附上实际作答的端点标签。
   */
  const ask = async (
    state: unknown,
    questions: JevQuestion[],
    options?: { model?: string; signal?: AbortSignal; budgetMs?: number },
  ): Promise<JevResult> => {
    refreshConfig()
    const serialized = typeof state === 'string' ? state : JSON.stringify(state)
    if (serialized === undefined) throw new Error('state 不是可序列化的 JSON 值。')
    if (serialized.length > config.maxStateChars) {
      throw new Error('state 共 ' + String(serialized.length) + ' 字符，超过上限 '
        + String(config.maxStateChars) + '；请先裁剪再提问。')
    }

    const failures: string[] = []
    let sawKey = false
    const endpointList = endpointsOf()
    const deadline = options?.budgetMs === undefined ? undefined : Date.now() + options.budgetMs
    for (let index = 0; index < endpointList.length; index++) {
      const endpoint = endpointList[index]
      const apiKey = await resolveKey(endpoint.apiKeyEnv)
      if (apiKey === undefined) {
        failures.push(endpoint.label + '：未找到 ' + endpoint.apiKeyEnv)
        continue
      }
      sawKey = true
      // 每个端点各分一份预算。不分的话第一个端点会吃光整条链路的超时，
      // 备选端点拿到的其实是一个已经中止的信号——它报出来的"超时"是饿死，不是真的慢
      // （2026-09-18 的日志里两个端点同时报 timeout 就是这个原因）。
      const left = deadline === undefined ? config.timeoutMs : deadline - Date.now()
      if (deadline !== undefined && left <= 250) {
        failures.push(endpoint.label + '：链路预算已耗尽，未尝试')
        break
      }
      const attemptBudget = deadline === undefined
        ? config.timeoutMs
        : Math.max(200, Math.min(config.timeoutMs, Math.floor(left / (endpointList.length - index))))
      const body = JSON.stringify(buildBody(state as StateInput, questions, options?.model ?? endpoint.model))
      const url = endpoint.baseURL.replace(/\/+$/, '') + endpoint.path
      let lastError = ''
      for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
        const timeout = AbortSignal.timeout(attemptBudget)
        const signal = options?.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal])
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
            body,
            signal,
          })
          const text = await response.text()
          if (response.ok) return { ...(JSON.parse(text) as JevResult), endpoint: endpoint.label }
          lastError = explainStatus(response.status, text.slice(0, 400))
          if (response.status !== 429 && response.status !== 529) break
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error)
          break // 网络层失败不在同一端点重试：立刻换下一个端点。
        }
        if (attempt < config.maxRetries) await sleep(2 ** attempt * 500)
      }
      failures.push(endpoint.label + '：' + lastError)
    }

    if (!sawKey) {
      throw new Error('未找到任何 Jev API key：可用 ctx.credentials 的托管库、进程环境变量，'
        + '或 ' + config.credentialsPath + ' 的 refs: 段提供。（' + failures.join('；') + '）')
    }
    throw new Error('Jev 判定失败：' + failures.join('；'))
  }

  /**
   * 记一条"没有经过判定器"的流水：只读跳过、形状缓存命中、已批准的形状。
   * 六个调用点字段完全一致，只有 path 与结论不同——之前是六份复制粘贴。
   * @param target - 记录到哪张闸门的流水（通用或 CU）。
   * @param base - 这条记录归属的调用。
   * @param path - 走了哪条路径。
   * @param verdict - 结论；没有结论时传 null。
   * @param reason - 结论理由；没有时传 null。
   */
  const recordLite = (
    target: GateStore,
    base: { session: string; mode: GateMode; tool: string; nested: boolean; cu?: boolean },
    path: GatePath,
    verdict: string | null,
    reason: string | null,
  ): void => {
    target.record({
      ts: new Date().toISOString(),
      session: base.session,
      ...base.cu === true ? { gate: 'cu' } : {},
      mode: base.mode,
      tool: base.tool,
      nested: base.nested,
      path,
      unprotected: false,
      ms: 0,
      verdict,
      reason,
      error: null,
      usage: null,
    })
  }

  /**
   * 收尾处置：两个闸门只有那句失败理由不同。
   * @param merged - 合并后的结论（undefined 表示判定失败）。
   * @param failClosed - 失败时是否按高风险改问人。
   * @param mode - 本会话的闸门模式。
   * @param failureReason - 失败并升级给人时展示的理由。
   * @returns 处置；返回 undefined 表示应当交回后续监听器。
   */
  const dispositionOf = (
    merged: GateVerdict | undefined,
    failClosed: boolean,
    mode: GateMode,
    failureReason: string,
  ): GateDecision | undefined => {
    if (merged === undefined) {
      if (!failClosed || mode === 'shadow') return undefined
      return { kind: 'ask', reason: failureReason }
    }
    if (mode === 'shadow') return undefined
    if (merged.kind === 'ask') return { kind: 'ask', reason: merged.reason }
    if (merged.kind === 'deny') return { kind: 'deny', reason: merged.reason }
    return undefined
  }

  /**
   * 判定失败时怎么降级，以及这次记成哪条路径。
   * @param merged - 合并后的结论；undefined 表示判定失败。
   * @param takeover - 是否由放权后的模型结论接管。
   * @param tool - 工具名。
   * @param args - 工具参数。
   * @returns 失败时是否改问人，以及本次记录的 path。
   */
  const failurePolicy = (
    merged: GateVerdict | undefined,
    takeover: boolean,
    tool: string,
    args: unknown,
  ): { failClosed: boolean; path: GatePath } => {
    const failClosed = merged === undefined
      && config.gateFailClosedOnTimeout !== false
      && riskClassOf(tool, args) === 'high'
    return {
      failClosed,
      path: merged === undefined ? (failClosed ? 'failclosed' : 'failopen') : (takeover ? 'llm' : 'jev'),
    }
  }

  /**
   * 判定前的公共预检：只读跳过、形状缓存命中、已批准的形状。
   *
   * 两个闸门在这段上逐字相同，只有"用哪张流水、用哪份跳过名单、要不要打 CU 标记"不同。
   * @param input - 本次调用与闸门档案。
   * @returns 下一步动作；`judge` 时带上这次调用的形状键（可能因参数过大而缺失）。
   */
  const gatePrologue = (input: {
    exec: GateExec
    sessionId: string
    mode: GateMode
    store: GateStore
    cu: boolean
    contributions: number
    shouldSkipObserve: boolean
  }): { kind: 'next' } | { kind: 'decision'; decision: GateDecision } | { kind: 'judge'; shape: string | undefined } => {
    const base = {
      session: input.sessionId,
      mode: input.mode,
      tool: input.exec.name,
      nested: input.exec.parent !== undefined,
      ...input.cu ? { cu: true } : {},
    }
    if (input.contributions === 0 && input.shouldSkipObserve) {
      recordLite(input.store, base, 'skip-observe', null, null)
      return { kind: 'next' }
    }
    // 形状缓存命中：同一会话里同样的工具 + 同样的参数，直接复用结论，一次网络都不发。
    const shape = shapeKeyOf(input.sessionId, input.exec.name, input.exec.arguments)
    const cached = shape === undefined ? undefined : cachedVerdict(shape)
    if (cached !== undefined) {
      recordLite(input.store, base, 'cache', cached.kind, cached.reason)
      if (input.mode !== 'shadow' && (cached.kind === 'ask' || cached.kind === 'deny')) {
        return { kind: 'decision', decision: { kind: cached.kind, reason: cached.reason } }
      }
      return { kind: 'next' }
    }
    if (shape !== undefined && approvedRecently(shape)) {
      recordLite(input.store, base, 'shape-approved', 'pass', '该形状在本会话内已被人工批准过')
      return { kind: 'next' }
    }
    return { kind: 'judge', shape }
  }

  /**
   * 注册一个服务；同名服务已经被注册过时只记一条诊断，不让整个插件加载失败。
   *
   * 热重载路径上，上一个实例可能还没释放服务名（实测会让 entry 直接变成 [failed]，
   * 新代码再也装不进来）。这三个服务都是无状态的，让监听器与工具照常装配比直接失败有用得多。
   * @param name - 服务名。
   * @param value - 服务实现。
   */
  const provideResilient = (name: string, value: unknown): void => {
    try {
      ctx.provide(name, value)
    } catch (error) {
      try {
        mkdirSync(GATE_HOME, { recursive: true })
        appendFileSync(join(GATE_HOME, 'load-error.log'),
          new Date().toISOString() + ' provide(' + name + ') 被拒，已跳过：'
          + (error instanceof Error ? error.message : String(error)) + '\n')
      } catch {
        // 诊断写不进去不影响装配。
      }
    }
  }

  /**
   * 注册一个模型可见工具；同名工具已被注册过时只记一条诊断。
   *
   * 与 {@link provideResilient} 同理：热重载时上一代实例还可能占着工具名，
   * 直接抛错会让整个 entry 变成 [failed]，新代码再也装不进来。旧的那份行为一致，
   * 保留它不影响正确性；重要的是这次装配的监听器要装上。
   * @param tool - defineTool 的产物。
   * @param label - 注销时用的标签。
   */
  const registerResilient = (tool: unknown, label: string): void => {
    try {
      ctx.effect(() => ctx.tools.register(tool as Parameters<typeof ctx.tools.register>[0]), label)
    } catch (error) {
      try {
        mkdirSync(GATE_HOME, { recursive: true })
        appendFileSync(join(GATE_HOME, 'load-error.log'),
          new Date().toISOString() + ' register(' + label + ') 被拒，已跳过：'
          + (error instanceof Error ? error.message : String(error)) + '\n')
      } catch {
        // 同上：诊断不影响装配。
      }
    }
  }

  provideResilient('jev', { available: async () => await anyEndpointUsable(), ask } satisfies JevService)

  // 其它插件把自己的判定挂进同一次调用：一次判定问完所有问题，输入只算一次。
  provideResilient('jevGate', {
    contribute(id: string, factory: (input: GateContributionInput) => GateContribution | undefined): () => void {
      contributorFactories.set(id, { factory, at: Date.now() })
      return () => { contributorFactories.delete(id) }
    },
  } satisfies JevGateService)

  // 可选的浏览器可见性分类器：浏览器 provider 在会话首次调用前问一次，
  // 答 true 才把该会话的浏览器换成有头窗口。任何失败都答 false —— 分类器绝不能
  // 阻塞调用，也不能在判不出来时擅自改变默认行为。
  provideResilient('browserVisibility', {
    async visible(context: { agent?: unknown }): Promise<boolean> {
      refreshConfig()
      if (config.browserVisibilityEnabled === false) return false
      const task = latestUserTask(sessionOf(context?.agent))
      if (task === undefined || task.length === 0) return false
      if (!(await anyEndpointUsable())) return false
      try {
        const result = await ask({ task }, [VISIBILITY_QUESTION], {
          signal: AbortSignal.timeout(Math.min(config.timeoutMs, VISIBILITY_BUDGET_MS)),
        })
        const answer = result.answers['visible']
        return answer?.type === 'noul' && answer.noul >= 0.5
      } catch {
        return false // 超时、限流、没 key：一律按不可见处理，保持默认行为。
      }
    },
  })

  registerResilient(defineTool({
    name: 'jev_judge',
    description:
      'Ask TypeSafe Jev (a System One decision model, NOT a chat model) to make narrow, typed judgments about a piece of '
      + 'content, and get structured answers back. Use it instead of reasoning out a classification, a routing decision, '
      + 'a relevance or threshold call, or a rubric score yourself: it takes about 100-300ms, costs $0.042 per million '
      + 'input tokens with free output, and returns probabilities plus a confidence value you can branch on. Put the '
      + 'material to judge in state; ask one focused question per entry in questions, and ask several at once — they are '
      + 'evaluated in parallel against the same state and cost almost nothing extra. Types: "choice" picks one option '
      + 'from criteria (a map of option to description, or null); "score" rates on criteria (an ordered array of at least '
      + 'two level descriptions); "noul" returns the probability that a yes/no statement holds (optional criteria '
      + '{true, false} explains the two poles). Decompose a compound judgment into atomic questions and combine the '
      + 'answers in your own logic rather than asking one broad question. Notes: the state is text only (no images), '
      + 'English is far more accurate than CJK, and confidence below roughly 0.5 means the model is genuinely unsure — '
      + 'do not guess, fall back or ask a human instead.',
    parameters: {
      state: {
        type: 'json',
        required: true,
        description: 'The content to judge: a string, or an object or array carrying the surrounding context.',
      },
      questions: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: 'Key this answer comes back under.' },
            type: { type: 'string', required: true, enum: ['choice', 'score', 'noul'] },
            instructions: { type: 'string', required: true, description: 'The one judgment to make about the state.' },
            criteria: {
              type: 'json',
              description: 'choice: {"option": "description" or null}; score: ["level 0", "level 1", ...]; noul: {"true": "...", "false": "..."}.',
            },
          },
        },
        description: 'One entry per focused question. All questions see the same state and are evaluated in parallel.',
      },
      model: { type: 'string', description: 'Override the model id (default ' + config.model + ').' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: 'Whether Jev returned answers.' },
          text: { type: 'string', required: true, description: 'Model-facing rendering.' },
          answers: { type: 'json', description: 'Answers keyed by question id.' },
          usage: { type: 'json', description: 'Token usage reported by TypeSafe.' },
          error: { type: 'string' },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: (value as { text: string }).text }],
    },
    timeoutMs: config.timeoutMs + 15_000,
    isConcurrencySafe: () => true,
    async execute(args: { state: StateInput; questions: JevQuestion[]; model?: string }) {
      try {
        const result = await ask(args.state, args.questions, args.model === undefined ? undefined : { model: args.model })
        const lines: string[] = ['jev_judge -> OK', '', 'model: ' + result.model]
        if (result.endpoint !== undefined) lines.push('endpoint: ' + result.endpoint)
        for (const [id, answer] of Object.entries(result.answers)) {
          if (answer.type === 'noul') lines.push(id + ': noul=' + String(answer.noul))
          else if (answer.type === 'choice') lines.push(id + ': choice=' + answer.choice + ' confidence=' + String(answer.confidence) + ' probabilities=' + JSON.stringify(answer.probabilities))
          else lines.push(id + ': score=' + String(answer.score) + ' confidence=' + String(answer.confidence) + ' probabilities=' + JSON.stringify(answer.probabilities))
        }
        lines.push('', 'usage: ' + JSON.stringify(result.usage))
        return { ok: true, text: lines.join('\n'), answers: result.answers as never, usage: result.usage as never }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, text: 'jev_judge -> FAILED: ' + message, error: message }
      }
    },
  }), '@dsh-external/dsh-jev: jev_judge')

  registerResilient(defineTool({
    name: 'jev_gate',
    description:
      'Turn a Jev judgement gate on or off for THIS conversation (or for every conversation without an explicit '
      + 'setting). Two independent gates exist: "tools" (the default) judges ordinary tool calls such as shell, file, '
      + 'and network tools, while "cu" judges computer-use and browser-use actions such as desktop clicks and typing, '
      + 'page clicks, form submits, uploads, downloads, and process control. Each gate sits on the tool-approval path: '
      + 'in "shadow" mode it asks Jev to judge every matching call and only writes a research record without changing '
      + 'anything; in "enforce" mode it can escalate a call to human approval. Use action="shadow" when the user wants '
      + 'to trial it, action="enforce" to let it actually gate, action="off" to stop, and action="status" to report '
      + 'the current modes, state files, endpoint fallback order, and shadow-record location. This is the switch the '
      + 'user means when they say "turn the Jev gate on/off in this chat".',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['status', 'off', 'shadow', 'enforce'],
        description: 'status reports; off/shadow/enforce set the mode.',
      },
      scope: {
        type: 'string',
        enum: ['session', 'all'],
        description: 'session (default) applies to this conversation only; all changes the fallback for conversations with no explicit setting.',
      },
      gate: {
        type: 'string',
        enum: ['tools', 'cu'],
        description: 'Which gate to act on: tools (default) for ordinary tool calls, cu for computer-use and browser-use actions.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true, description: 'Model-facing rendering.' },
          mode: { type: 'string', description: 'Effective mode after this call.' },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: (value as { text: string }).text }],
    },
    isConcurrencySafe: () => false,
    async execute(args: { action: string; scope?: string; gate?: string }, exec: { agent?: { session?: unknown } }) {
      refreshConfig()
      const facts = sessionFacts(exec?.agent?.session)
      const scope = args.scope ?? 'session'
      const which = args.gate === 'cu' ? 'cu' : 'tools'
      const targetStore = which === 'cu' ? cuStore : store
      const defaultMode = which === 'cu' ? (config.cuGateDefaultMode ?? 'shadow') : config.gateDefaultMode
      const stateFile = which === 'cu'
        ? (config.cuGateStateFile ?? join(GATE_HOME, 'cu-state.json'))
        : config.gateStateFile
      const target = scope === 'all' ? '*' : facts.id
      const lines: string[] = []
      if (target === undefined && args.action !== 'status') {
        return { text: 'jev_gate: 无法确定当前会话 ID，无法按会话设置。', mode: 'unknown' }
      }
      if (args.action !== 'status') {
        targetStore.set(target as string, args.action as GateMode)
        lines.push(scope === 'all'
          ? '已将没有显式设置的会话的 ' + which + ' 闸门模式设为 ' + args.action + '。'
          : '已把本会话（' + String(target) + '）的 ' + which + ' 闸门模式设为 ' + args.action + '。')
      }
      const effective = facts.id === undefined ? targetStore.mode('') : targetStore.mode(facts.id)
      lines.push('闸门: ' + which + (which === 'cu' ? '（computer-use / browser-use）' : '（通用工具）'))
      lines.push('本会话有效模式: ' + effective + '（默认 ' + defaultMode + '）')
      lines.push('pattern: off=不判定; shadow=判定并记录、不拦截; enforce=判定结果会拦截/升级到人')
      lines.push('状态文件: ' + stateFile)
      lines.push('记录目录: ' + config.gateShadowDir + '（' + (which === 'cu' ? 'cu-' : '') + 'shadow-YYYY-MM-DD.jsonl）')
      const entries = Object.entries(targetStore.all())
      lines.push('已显式设置: ' + (entries.length === 0 ? '（无）' : entries.map(([k, v]) => (k === '*' ? '*（默认）' : k) + '=' + v).join(', ')))
      const toolMode = facts.id === undefined ? store.mode('') : store.mode(facts.id)
      const cuMode = facts.id === undefined ? cuStore.mode('') : cuStore.mode(facts.id)
      lines.push('两个闸门当前: tools=' + toolMode + ' / cu=' + cuMode + (cuGateOn ? '' : '（cu 已在配置里关闭）'))
      const endpointState: string[] = []
      for (const endpoint of endpointsOf()) {
        const has = (await resolveKey(endpoint.apiKeyEnv)) !== undefined
        endpointState.push(endpoint.label + '=' + (has ? '已配置 key(' + endpoint.apiKeyEnv + ')' : '无 key(' + endpoint.apiKeyEnv + ')'))
      }
      lines.push('端点回退顺序: ' + endpointState.join(' → '))
      if (!(await anyEndpointUsable())) lines.push('注意：当前没有任何可用 key，闸门会直接放行且不产生判定。')
      return { text: lines.join('\n'), mode: effective }
    },
  }), '@dsh-external/dsh-jev: jev_gate')

  const onEvent = ctx as unknown as {
    on(
      name: string,
      handler: (exec: GateExec, next: () => Promise<GateDecision>) => Promise<GateDecision>,
      options?: { prepend?: boolean },
    ): () => void
  }

  // 批准记忆的另一半：闸门抛出 ask 之后，只要这次调用真的执行到了 post-execute，
  // 就说明人工点了"允许"。默认关闭（gateApproveOnceTtlMs = 0）。
  const onPostEvent = ctx as unknown as {
    on(name: string, handler: (exec: GateExec, result: unknown, next: () => Promise<unknown>) => Promise<unknown>): () => void
  }
  ctx.effect(() => onPostEvent.on('tools/post-execute', async (exec, result, next) => {
    const callId = (exec as { callId?: unknown } | undefined)?.callId
    if (callId !== undefined && callId !== null) {
      const pending = pendingShapes.get(String(callId))
      if (pending !== undefined) {
        pendingShapes.delete(String(callId))
        const failed = result !== null && typeof result === 'object' && (result as { isError?: unknown }).isError === true
        const approveTtl = config.gateApproveOnceTtlMs ?? 0
        if (!failed && approveTtl > 0) {
          approvedShapes.set(pending.shape, Date.now())
          boundMap(approvedShapes, 512, (at) => Date.now() - at > approveTtl)
        }
      }
    }
    return next()
  }), '@dsh-external/dsh-jev: approved-shape memory')

  ctx.effect(() => onEvent.on('tools/pre-execute', async (exec, next): Promise<GateDecision> => {
    const facts = sessionFacts(exec.agent?.session)
    // 没有会话归属、或只是顶层 run_code 包装器（真正要判的是它内部的子调用）时跳过。
    if (facts.id === undefined) return next()
    if (exec.name === 'jev_gate' || exec.name === 'jev_judge') return next()
    if (exec.parent === undefined && exec.name === 'run_code') return next()
    refreshConfig()
    // CU/BU 工具归专用闸门管：通用闸门问的是文件口径，重复判定只会白花一次往返。
    if (cuGateOn && inCuFamily(exec.name)) return next()
    const mode = store.mode(facts.id)
    // 其它插件（例如约束执行插件）可以把自己的判定挂进同一次调用：一次判定问完所有问题。
    // 没有贡献者时，这里的行为与以前完全一致。
    const contributions = collectContributions(exec)
    if (mode === 'off' && contributions.length === 0) return next()
    // 只读/自省跳过 + 形状缓存 + 已批准形状：两个闸门共用同一段预检。
    const pre = gatePrologue({
      exec,
      sessionId: facts.id,
      mode,
      store,
      cu: false,
      contributions: contributions.length,
      shouldSkipObserve: config.gateObserveSkip !== false
        && isGateObserveTool(exec.name, config.gateObserveTools ?? GATE_OBSERVE_TOOLS),
    })
    if (pre.kind === 'next') return next()
    if (pre.kind === 'decision') return pre.decision
    const shape = pre.shape
    if (!(await anyEndpointUsable())) return next()

    // 预算随 state 体积轻微放大：大 state 传得慢、推得也慢，同一个超时更容易失败。
    const gateStatePayload = gateState(exec.name, exec.arguments, facts.cwd, { maxStringChars: config.gateArgChars ?? 2000 })
    // 贡献者的额外字段并进同一个 state、问题并进同一组问题：输入只算一次，往返也只有一次。
    const mergedState = (contributions.length === 0
      ? gateStatePayload
      : Object.assign({}, gateStatePayload, ...contributions.map((item) => item.state ?? {}))) as typeof gateStatePayload
    const mergedQuestions = contributions.length === 0
      ? gateQuestions
      : [...gateQuestions, ...contributions.flatMap((item) => item.questions)]
    const gateBudgetMs = scaledTimeoutMs(config.gateTimeoutMs, stableJson(mergedState).length)
    const started = Date.now()
    let verdict: GateVerdict | undefined
    let error: string | undefined
    let usage: unknown
    let jevAnswers: GateAnswers | undefined
    let rawAnswers: Record<string, JevAnswer> | undefined
    try {
      const result = await ask(
        mergedState,
        mergedQuestions,
        { signal: AbortSignal.timeout(gateBudgetMs), budgetMs: gateBudgetMs },
      )
      usage = result.usage
      rawAnswers = result.answers
      jevAnswers = toGateAnswers(result.answers)
      if (jevAnswers === undefined) error = 'Jev 返回的答案缺少闸门需要的字段'
      else verdict = verdictOf(jevAnswers, config.gateAskThreshold, config.gateDenyThreshold)
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }

    // 贡献者结算：同一次调用里的额外问题在这里变成各自的处置（它们自己写流水）。
    const settled = contributions
      .map((item) => safeSettle(item.id, item.settle, rawAnswers, error))
      .filter((item): item is { id: string; verdict: ContributorVerdict } => item !== undefined)

    // ── 放权：判定器糊涂时，把决定权交给带完整上下文的 LLM 分类器 ──
    const jevSummary: JevSummary = {
      ...verdict === undefined ? {} : { verdict: verdict.kind, reason: verdict.reason },
      ...jevAnswers === undefined ? {} : { score: jevAnswers.needs_human_approval.noul },
      threshold: config.gateAskThreshold,
    }
    const trigger = escalateTriggerOf({
      tool: exec.name,
      args: exec.arguments,
      ...verdict === undefined ? {} : { verdict: verdict.kind },
      summary: jevSummary,
      margin: config.escalateMargin ?? 0.1,
      lowConfidence: config.escalateLowConfidence ?? 0.5,
      enableLowConfidence: config.escalateEnableLowConfidence === true,
      thinConfidence: config.escalateThinConfidence ?? 0.8,
      dimensions: jevAnswers === undefined
        ? {}
        : {
            effect: jevAnswers.effect.choice,
            touches_outside_project: jevAnswers.touches_outside_project.noul,
            confidence: jevAnswers.effect.confidence,
          },
    })
    const escalation = trigger === undefined
      ? undefined
      : await runEscalation(exec, exec.agent?.session, facts, trigger, jevSummary)

    // enforce 下的放权真正接管处置：可以更严，也可以更松 —— 更松正是放权的意义。
    const takeover = escalation !== undefined && escalation.mode === 'enforce'
      && escalation.decision !== undefined && mode !== 'shadow'
    // 闸门自己的结论。本会话模式为 off 时闸门不上岗，但仍然可能替贡献者把问题问出去。
    const gateVerdict: GateVerdict | undefined = mode === 'off'
      ? undefined
      : takeover
        ? escalation.decision === 'deny'
          ? { kind: 'deny', reason: 'jev→llm: ' + (escalation.reason ?? '模型判定必须拒绝') }
          : escalation.decision === 'ask'
            ? { kind: 'ask', reason: 'jev→llm: ' + (escalation.reason ?? '模型判定需人工确认') }
            : { kind: 'pass', reason: 'jev→llm: ' + (escalation.reason ?? '模型判定可以放行') }
        : verdict

    // 贡献者的处置并进来：最严的赢。它们各自的模式决定是否生效（shadow 只记录不拦）。
    const effective = foldContributions(gateVerdict, settled)

    // 判定失败时的降级方向按确定性风险分档：高风险问人，其余才交回既有权限链。
    const { failClosed, path } = failurePolicy(effective, takeover, exec.name, exec.arguments)

    store.record({
      ts: new Date().toISOString(),
      session: facts.id,
      mode,
      tool: exec.name,
      nested: exec.parent !== undefined,
      path,
      unprotected: path === 'failopen',
      escalate: escalation ?? null,
      contrib: settled.length === 0 ? null : settled.map((item) => ({ id: item.id, kind: item.verdict.kind, effective: item.verdict.effective })),
      args: preview(exec.arguments, config.gatePreviewChars),
      ms: Date.now() - started,
      verdict: effective === undefined ? null : effective.kind,
      reason: effective === undefined ? null : effective.reason,
      error: error ?? null,
      usage: usage ?? null,
    })

    // 只在"这次结论完全出自闸门自己"时才进缓存。
    // 贡献者的结论取决于它自己的模式（shadow/enforce）与它读的简报，模式一改就可能不再成立，
    // 缓存它会让"切到影子模式"对已经见过的形状失效（实测：切 shadow 后同一个形状仍被缓存里的否决挡住）。
    if (effective !== undefined && shape !== undefined && settled.length === 0) {
      rememberVerdict(shape, effective, exec.callId)
    }

    // 判定失败：高风险不放行（交给人工），其余交回 DSH 既有的权限链。
    return dispositionOf(
      effective,
      failClosed,
      mode,
      'jev gate: 判定失败（' + String(error ?? '').slice(0, 120) + '）；该调用属高风险类别，改由人工确认',
    ) ?? next()
  }, { prepend: true }), '@dsh-external/dsh-jev: judgment gate')

  ctx.effect(() => onEvent.on('tools/pre-execute', async (exec, next): Promise<GateDecision> => {
    refreshConfig()
    if (!cuGateOn) return next()
    if (!inCuFamily(exec.name)) return next()
    const facts = sessionFacts(exec.agent?.session)
    if (facts.id === undefined) return next()
    if (exec.name === 'jev_gate' || exec.name === 'jev_judge') return next()
    if (exec.parent === undefined && exec.name === 'run_code') return next()
    const mode = cuStore.mode(facts.id)
    const contributions = collectContributions(exec)
    if (mode === 'off' && contributions.length === 0) return next()
    // 纯观察跳过 + 形状缓存 + 已批准形状：与通用闸门共用同一段预检。
    const pre = gatePrologue({
      exec,
      sessionId: facts.id,
      mode,
      store: cuStore,
      cu: true,
      contributions: contributions.length,
      shouldSkipObserve: isCuObserve(exec.name),
    })
    if (pre.kind === 'next') return next()
    if (pre.kind === 'decision') return pre.decision
    const shape = pre.shape
    if (!(await anyEndpointUsable())) return next()

    const cuStatePayload = cuGateState(exec.name, exec.arguments, facts.cwd, { redactKeys: cuRedactKeys, maxStringChars: cuArgChars })
    const mergedCuState = (contributions.length === 0
      ? cuStatePayload
      : Object.assign({}, cuStatePayload, ...contributions.map((item) => item.state ?? {}))) as typeof cuStatePayload
    const mergedCuQuestions = contributions.length === 0
      ? cuQuestions
      : [...cuQuestions, ...contributions.flatMap((item) => item.questions)]
    const cuBaseTimeout = config.cuGateTimeoutMs ?? config.gateTimeoutMs
    const cuBudgetMs = scaledTimeoutMs(cuBaseTimeout, stableJson(mergedCuState).length)
    const started = Date.now()
    let verdict: GateVerdict | undefined
    let error: string | undefined
    let usage: unknown
    let endpoint: string | undefined
    let cuAnswers: CuGateAnswers | undefined
    let rawAnswers: Record<string, JevAnswer> | undefined
    try {
      const result = await ask(
        mergedCuState,
        mergedCuQuestions,
        { signal: AbortSignal.timeout(cuBudgetMs), budgetMs: cuBudgetMs },
      )
      usage = result.usage
      endpoint = result.endpoint
      rawAnswers = result.answers
      cuAnswers = toCuAnswers(result.answers)
      if (cuAnswers === undefined) error = 'Jev 返回的答案缺少 CU 闸门需要的字段'
      else {
        verdict = cuVerdictOf(
          cuAnswers,
          config.cuGateAskThreshold ?? config.gateAskThreshold,
          config.cuGateDenyThreshold ?? config.gateDenyThreshold,
        )
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }

    // 贡献者结算：同一次调用里的额外问题在这里变成各自的处置。
    const settled = contributions
      .map((item) => safeSettle(item.id, item.settle, rawAnswers, error))
      .filter((item): item is { id: string; verdict: ContributorVerdict } => item !== undefined)

    // ── 放权：判定器糊涂时交给带上下文的 LLM 分类器 ──
    const jevSummary: JevSummary = {
      ...verdict === undefined ? {} : { verdict: verdict.kind, reason: verdict.reason },
      ...cuAnswers === undefined ? {} : { score: cuAnswers.needs_human_approval.noul },
      threshold: config.cuGateAskThreshold ?? config.gateAskThreshold,
    }
    const trigger = escalateTriggerOf({
      tool: exec.name,
      args: exec.arguments,
      ...verdict === undefined ? {} : { verdict: verdict.kind },
      summary: jevSummary,
      margin: config.escalateMargin ?? 0.1,
      lowConfidence: config.escalateLowConfidence ?? 0.5,
      enableLowConfidence: config.escalateEnableLowConfidence === true,
      thinConfidence: config.escalateThinConfidence ?? 0.8,
      dimensions: cuAnswers === undefined
        ? {}
        : {
            action_kind: cuAnswers.action_kind.choice,
            reversibility: cuAnswers.reversibility.score,
            confidence: cuAnswers.action_kind.confidence,
          },
    })
    const escalation = trigger === undefined
      ? undefined
      : await runEscalation(exec, exec.agent?.session, facts, trigger, jevSummary)

    const takeover = escalation !== undefined && escalation.mode === 'enforce'
      && escalation.decision !== undefined && mode !== 'shadow'
    // 闸门自己的结论。本会话模式为 off 时闸门不上岗，但仍然可能替贡献者把问题问出去。
    const gateVerdict: GateVerdict | undefined = mode === 'off'
      ? undefined
      : takeover
        ? escalation.decision === 'deny'
          ? { kind: 'deny', reason: 'jev→llm cu gate: ' + (escalation.reason ?? '模型判定必须拒绝') }
          : escalation.decision === 'ask'
            ? { kind: 'ask', reason: 'jev→llm cu gate: ' + (escalation.reason ?? '模型判定需人工确认') }
            : { kind: 'pass', reason: 'jev→llm cu gate: ' + (escalation.reason ?? '模型判定可以放行') }
        : verdict

    // 贡献者的处置并进来：最严的赢。
    const effective = foldContributions(gateVerdict, settled)

    const failClosed = effective === undefined
      && config.gateFailClosedOnTimeout !== false
      && riskClassOf(exec.name, exec.arguments) === 'high'
    const path: GatePath = effective === undefined
      ? (failClosed ? 'failclosed' : 'failopen')
      : (takeover ? 'llm' : 'jev')

    cuStore.record({
      ts: new Date().toISOString(),
      session: facts.id,
      gate: 'cu',
      mode,
      tool: exec.name,
      nested: exec.parent !== undefined,
      path,
      unprotected: path === 'failopen',
      escalate: escalation ?? null,
      contrib: settled.length === 0 ? null : settled.map((item) => ({ id: item.id, kind: item.verdict.kind, effective: item.verdict.effective })),
      args: preview(exec.arguments, config.gatePreviewChars),
      ms: Date.now() - started,
      verdict: effective === undefined ? null : effective.kind,
      reason: effective === undefined ? null : effective.reason,
      endpoint: endpoint ?? null,
      error: error ?? null,
      usage: usage ?? null,
    })

    // 只在"这次结论完全出自闸门自己"时才进缓存。
    // 贡献者的结论取决于它自己的模式（shadow/enforce）与它读的简报，模式一改就可能不再成立，
    // 缓存它会让"切到影子模式"对已经见过的形状失效（实测：切 shadow 后同一个形状仍被缓存里的否决挡住）。
    if (effective !== undefined && shape !== undefined && settled.length === 0) {
      rememberVerdict(shape, effective, exec.callId)
    }

    // 判定失败：高风险不放行（交给人工），其余交回 DSH 既有的权限链。
    return dispositionOf(
      effective,
      failClosed,
      mode,
      'jev cu gate: 判定失败（' + String(error ?? '').slice(0, 120) + '）；该动作属高风险类别，改由人工确认',
    ) ?? next()
  }, { prepend: true }), '@dsh-external/dsh-jev: computer-use judgment gate')
}
