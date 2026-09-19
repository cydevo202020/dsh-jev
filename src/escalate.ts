/**
 * dsh-jev 的"放权"子模块：判断判定器是不是"糊涂了"，以及在糊涂时把决定权交给
 * 带完整上下文的 LLM 分类器。
 *
 * 这里刻意不放任何网络代码，也不碰 Cordis：触发器、上下文快照、输出解析都是纯函数，
 * 可以离线测；真正调用 LLM 的那一步在 index.ts 里。
 *
 * 五条触发条件（只有 U4 依赖置信度，而实测置信度没有区分力，所以默认不启用）：
 * - U1 信息不足：参数里没有任何"描述这次动作到底做什么"的内容（只有文件名/编号/占位符）
 * - U2 贴着分数线：判定分数距离阈值太近，等于掷硬币
 * - U3 维度互相矛盾：结论自相冲突，例如"只读"却"越出工作目录很高"
 * - U4 低置信：判定器自己报的置信度过低（默认关闭，需要先用带标注的数据校准）
 * - U5 判定失败：端点超时或返回结构不符
 * @module @dsh-external/dsh-jev/escalate
 */

/** 放权触发条件。 */
export type EscalateTrigger = 'U1' | 'U2' | 'U3' | 'U4' | 'U5'

/** LLM 分类器给出的处置。 */
export type EscalationDecision = 'allow' | 'ask' | 'deny'

/** 放权模式：关闭 / 只记录 / 真正接管。 */
export type EscalateMode = 'off' | 'shadow' | 'enforce'

/** 一次放权的结果，写进影子记录。 */
export interface EscalationOutcome {
  /** 触发它的条件。 */
  trigger: EscalateTrigger
  /** 实际生效的模式。 */
  mode: EscalateMode
  /** 模型给出的处置；解析失败时为 undefined。 */
  decision?: EscalationDecision
  /** 模型给出的风险等级。 */
  risk?: string
  /** 模型给出的一句话理由。 */
  reason?: string
  /** 这一趟花掉的毫秒数。 */
  ms: number
  /** 实际作答的模型（拿不到就省略）。 */
  model?: string
  /** 失败原因（超时、没配 llm 服务、输出不符合协议）。 */
  error?: string
  /** 诊断：这次实际收到多少个流式分片。 */
  chunks?: number
  /** 诊断：收到的文本开头一段（便于判断模型到底答了什么）。 */
  sample?: string
}

/** 判定器一次判定的可读摘要，用来给 LLM 当线索。 */
export interface JevSummary {
  /** 判定器给的处置（pass/ask/deny），失败时为 undefined。 */
  verdict?: 'pass' | 'ask' | 'deny'
  /** 一句话理由（reason 字段原样）。 */
  reason?: string
  /** 判定分数（needs_human_approval / action_kind 等）。 */
  score?: number
  /** 阈值，用来算 U2 的余量。 */
  threshold?: number
}

/** 一个值算不算"描述了这次动作到底做什么"。 */
function isInformative(value: unknown): boolean {
  if (typeof value === 'string') {
    const text = value.trim()
    if (text.length === 0) return false
    if (text.includes('\n')) return true          // 多行脚本
    if (text.length >= 120) return true           // 长文本
    if (/\s/.test(text)) return true              // 含空格的句子/命令
    return false                                  // 单个标识符、路径、编号
  }
  if (Array.isArray(value)) return value.some(isInformative)
  if (value !== null && typeof value === 'object') return Object.values(value as Record<string, unknown>).some(isInformative)
  return false                                    // 数字/布尔/null 都不含语义
}

/** 参数里是否出现了被脱敏的占位符。 */
function hasRedaction(value: unknown): boolean {
  if (typeof value === 'string') return /^<redacted/.test(value) || value.includes('<redacted ')
  if (Array.isArray(value)) return value.some(hasRedaction)
  if (value !== null && typeof value === 'object') return Object.values(value as Record<string, unknown>).some(hasRedaction)
  return false
}

/**
 * U1：判定器的输入里看不出这次动作到底要做什么。
 *
 * 触发情形（都由真实日志里的误判归纳出来）：
 * - 参数为空对象、或只有一个不承载语义的标量；
 * - 所有字符串都是路径/编号这类标识符，没有一句描述（2026-09-18 那 15 次
 *   {filename: "…step-1.js"} 被判成"不可逆破坏"就是这一类）；
 * - 关键内容已经被脱敏成占位符，判定器根本看不见。
 * @param args - 工具参数。
 * @returns 是否属于信息不足。
 */
export function inputLooksThin(args: unknown): boolean {
  if (args === null || args === undefined) return true
  if (typeof args !== 'object') return false
  const values = Array.isArray(args) ? args : Object.values(args as Record<string, unknown>)
  if (values.length === 0) return true
  if (hasRedaction(args)) return true
  return !values.some(isInformative)
}

/**
 * 从判定器的结论里挑出放权触发条件。
 *
 * 优先级 U1 > U5 > U3 > U2 > U4：越是"判定器根本没有依据"，越先放权。
 * @param input - 工具名与参数、判定器结论、阈值与余量。
 * @returns 命中的触发条件；都不命中时返回 undefined。
 */
export function escalateTriggerOf(input: {
  tool: string
  args: unknown
  verdict?: 'pass' | 'ask' | 'deny'
  summary: JevSummary
  margin: number
  lowConfidence: number
  enableLowConfidence: boolean
  /** 维度明细，用于 U3 的矛盾检测。 */
  dimensions?: Record<string, unknown>
  /** U1 的置信度门槛：判定器"自信放行"时不放权，默认 0.8。 */
  thinConfidence?: number
}): EscalateTrigger | undefined {
  // 判定器没答出来：先记成 U5，不再往下做矛盾检测。
  if (input.verdict === undefined) return 'U5'

  const dims = input.dimensions ?? {}
  const effect = dims['effect']
  const action = dims['action_kind']
  const outside = typeof dims['touches_outside_project'] === 'number' ? dims['touches_outside_project'] as number : undefined
  const reversibility = typeof dims['reversibility'] === 'number' ? dims['reversibility'] as number : undefined
  const conf = typeof dims['confidence'] === 'number' ? dims['confidence'] as number : undefined

  // 信息不足只在"判定器也不自信"时才值得放权。实测 299 条真实调用属于"参数里不含任何
  // 描述这次动作做什么的内容"，其中 276 条判定器以 0.94 的平均置信度放行——那些调用
  // （按包名、文件名、按键这类标识符判定的工具）本来就有足够依据，放权纯属白花一次
  // 大模型调用。收紧后需要放权的从 299 条降到 61 条。
  const confidentPass = input.verdict === 'pass' && conf !== undefined && conf >= (input.thinConfidence ?? 0.8)
  if (inputLooksThin(input.args) && !confidentPass && input.verdict !== 'deny') return 'U1'

  // U3：结论自己跟自己打架。
  if (effect === 'read_only' && outside !== undefined && outside >= 0.5) return 'U3'
  if (effect === 'read_only' && input.verdict === 'ask' && (input.summary.score ?? 0) >= 0.7) return 'U3'
  if (action === 'observe' && reversibility !== undefined && reversibility >= 1) return 'U3'
  if (action === 'destructive' && conf !== undefined && conf < 0.5) return 'U3'
  if (action === 'input' && input.verdict === 'ask' && reversibility !== undefined && reversibility >= 0.8) return 'U3'

  // U2：分数贴着分数线，没有决策余量。
  const threshold = input.summary.threshold
  const score = input.summary.score
  if (threshold !== undefined && score !== undefined && Math.abs(score - threshold) <= input.margin) return 'U2'

  // U4：判定器自报低置信（默认关闭）。
  if (input.enableLowConfidence && conf !== undefined && conf < input.lowConfidence) return 'U4'
  return undefined
}

/** 会话快照：给 LLM 分类器的"完整上下文"里最难拿也最值钱的那部分。 */
export interface SessionDigest {
  /** 最近几条真人指令的文本（新的在前）。 */
  requests: string[]
  /** 最近几次工具调用的名字与参数预览（新的在前）。 */
  calls: { tool: string; args: string }[]
}

/** 从事件里取文本部分。 */
function textOf(message: unknown): string | undefined {
  if (message === null || typeof message !== 'object') return undefined
  const content = (message as Record<string, unknown>)['content']
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue
    const text = (part as Record<string, unknown>)['text']
    if (typeof text === 'string') parts.push(text)
  }
  const joined = parts.join('\n').trim()
  return joined.length === 0 ? undefined : joined
}

/** 事件来源是不是真人（而不是插件注入的技能目录/运行时上下文）。 */
function isHumanSource(data: unknown): boolean {
  if (data === null || typeof data !== 'object') return false
  const record = data as Record<string, unknown>
  const nested = record['message'] !== null && typeof record['message'] === 'object'
    ? (record['message'] as Record<string, unknown>)['source']
    : undefined
  const source = record['source'] ?? nested
  return source !== null && typeof source === 'object' && (source as Record<string, unknown>)['kind'] === 'user'
}

/** 框架自己塞进来的文本，不是用户说的话。 */
function isFrameworkText(text: string): boolean {
  const head = text.trimStart()
  return head.startsWith('<system-reminder>') || head.startsWith('<compacted-summary>')
    || head.startsWith('Current runtime context') || head.startsWith('This is an automatically generated checkpoint')
}

/**
 * 读会话里最近的一段上下文：真人指令 + 最近的工具调用。
 *
 * 结构不符、取不到历史、会话对象形状变了，一律返回空快照——放权绝不能因为
 * 读不到上下文就报错，那会把闸门卡住。
 * @param session - agent.session。
 * @param limits - 各取几条。
 * @returns 会话快照。
 */
/** 一次快照最多回看的会话事件数：够跨过一整轮，又不随会话长度线性变慢。 */
const MAX_SCAN = 500

/**
 * 取一个按序号读会话事件的游标。
 *
 * 优先走 `eventAt` + `seq` 的按需读取：长会话里 `snapshotEvents()` 会把整段历史
 * 物化成数组，而放权只关心最近几条指令和最近几次调用。读取器不可用、或探到的
 * 事件形状与序号语义对不上时，退回 `snapshotEvents()`。
 * @param session - agent.session。
 * @returns 读取器；两种形状都不可用时为 undefined。
 */
function eventReader(session: unknown): { at: (index: number) => unknown; from: number } | undefined {
  if (session === null || typeof session !== 'object') return undefined
  const record = session as Record<string, unknown>
  const eventAt = record['eventAt']
  const seq = record['seq']
  if (typeof eventAt === 'function' && typeof seq === 'number' && seq > 0) {
    const read = eventAt as (index: number) => unknown
    const probe = read.call(session, seq - 1)
    if (probe !== null && typeof probe === 'object' && typeof (probe as Record<string, unknown>)['type'] === 'string') {
      return { at: (index) => read.call(session, index), from: seq - 1 }
    }
  }
  const snapshot = record['snapshotEvents']
  if (typeof snapshot === 'function') {
    try {
      const all = (snapshot as () => unknown).call(session)
      if (Array.isArray(all)) return { at: (index) => all[index], from: all.length - 1 }
    } catch {
      return undefined // 读不到历史：放权拿不到上下文，交给调用方按空快照处理。
    }
  }
  return undefined
}

export function sessionDigest(session: unknown, limits?: { requests?: number; calls?: number }): SessionDigest {
  const empty: SessionDigest = { requests: [], calls: [] }
  const reader = eventReader(session)
  if (reader === undefined) return empty
  const wantRequests = limits?.requests ?? 3
  const wantCalls = limits?.calls ?? 6
  const requests: string[] = []
  const calls: { tool: string; args: string }[] = []
  const floor = Math.max(0, reader.from - MAX_SCAN)
  for (let i = reader.from; i >= floor && (requests.length < wantRequests || calls.length < wantCalls); i--) {
    const event = reader.at(i)
    if (event === null || typeof event !== 'object') continue
    const typed = event as Record<string, unknown>
    const type = typed['type']
    if (type === 'user/message' && requests.length < wantRequests) {
      const data = typed['data']
      if (!isHumanSource(data)) continue
      const message = data !== null && typeof data === 'object' ? (data as Record<string, unknown>)['message'] : undefined
      const text = textOf(message)
      if (text === undefined || isFrameworkText(text)) continue
      requests.push(text.length > 600 ? text.slice(0, 600) : text)
      continue
    }
    if (type === 'tool/call' && calls.length < wantCalls) {
      const data = typed['data']
      if (data === null || typeof data !== 'object') continue
      const tool = (data as Record<string, unknown>)['name']
      const args = (data as Record<string, unknown>)['arguments']
      let preview = ''
      try {
        preview = typeof args === 'string' ? args : JSON.stringify(args ?? {})
      } catch {
        preview = '<unserializable>'
      }
      calls.push({ tool: String(tool), args: preview.length > 400 ? preview.slice(0, 400) : preview })
    }
  }
  return { requests, calls }
}

/** 放权请求的固定提示词。 */
export const ESCALATION_POLICY = [
  'You are a tool-call gate reviewer. A fast classifier (Jev) judged the pending call below but could not decide reliably, so the decision is yours.',
  'Decide whether the pending call may run, using the context: the working directory, the user instructions actually sent in this session, and the recent tool calls.',
  'Judge the concrete effect of the pending call, not the tool name and not the claimed intent.',
  'A call that the latest user instruction plainly asks for is allowed. Routine reversible work in the working directory is allowed.',
  'Answer with exactly one JSON object and nothing else:',
  '{"decision":"allow"|"ask"|"deny","risk":"low"|"medium"|"high","reason":"one short sentence"}',
  'allow = run it. ask = a human must confirm first. deny = it must not run.',
].join('\n')

/**
 * 拼出一次放权请求的正文。
 * @param input - 待判调用、触发原因、判定器线索、会话快照。
 * @returns 请求正文。
 */
export function escalationPrompt(input: {
  tool: string
  args: unknown
  cwd?: string
  trigger: EscalateTrigger
  jevSummary: JevSummary
  digest: SessionDigest
  maxArgChars: number
}): string {
  const { B, E } = { B: String.fromCharCode(96, 96, 96), E: String.fromCharCode(96, 96, 96) }
  let args = ''
  try {
    args = typeof input.args === 'string' ? input.args : JSON.stringify(input.args ?? {}, null, 1)
  } catch {
    args = '<unserializable>'
  }
  if (args.length > input.maxArgChars) args = args.slice(0, input.maxArgChars) + ' …[truncated]'
  return [
    'WHY_ESCALATED: ' + input.trigger + ' (' + TRIGGER_MEANING[input.trigger] + ')',
    'JEV_SAID: ' + (input.jevSummary.verdict ?? 'no answer') + ' — ' + (input.jevSummary.reason ?? 'n/a'),
    'WORKING_DIRECTORY: ' + (input.cwd ?? 'unknown'),
    'RECENT_USER_INSTRUCTIONS (newest first):',
    input.digest.requests.length === 0 ? '  (none visible)' : input.digest.requests.map((r) => '  - ' + r).join('\n'),
    'RECENT_TOOL_CALLS (newest first):',
    input.digest.calls.length === 0 ? '  (none visible)' : input.digest.calls.map((c) => '  - ' + c.tool + ' ' + c.args).join('\n'),
    'PENDING_CALL:',
    B + 'json',
    JSON.stringify({ tool: input.tool, arguments: input.args ?? {} }, null, 1).slice(0, input.maxArgChars + 200),
    E,
  ].join('\n')
}

/** 触发条件的人话解释，会随请求一起送给模型。 */
export const TRIGGER_MEANING: Record<EscalateTrigger, string> = {
  U1: 'the classifier was given no content that describes what the call does',
  U2: 'the classifier score sits right on the decision threshold',
  U3: 'the classifier reported two answers that contradict each other',
  U4: 'the classifier reported low confidence',
  U5: 'the classifier failed to answer (timeout or bad response)',
}

/**
 * 从模型输出里抠出决策 JSON。
 *
 * 容忍模型在 JSON 前后多写字：从最后一个左花括号开始做括号配对，取第一个能解析
 * 且字段合法的对象。
 * @param text - 模型输出的全文。
 * @returns 解析结果；不符合协议时为 undefined。
 */
export function parseEscalationDecision(text: unknown): { decision: EscalationDecision; risk?: string; reason?: string } | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined
  const attempts: string[] = []
  let depth = 0
  let start = -1
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      if (depth > 0) {
        depth--
        if (depth === 0 && start >= 0) attempts.push(text.slice(start, i + 1))
      }
    }
  }
  for (const candidate of attempts.reverse()) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const record = parsed as Record<string, unknown>
    const decision = record['decision']
    if (decision !== 'allow' && decision !== 'ask' && decision !== 'deny') continue
    const risk = typeof record['risk'] === 'string' ? record['risk'] : undefined
    const reason = typeof record['reason'] === 'string' ? record['reason'].slice(0, 300) : undefined
    return { decision, risk, reason }
  }
  return undefined
}
