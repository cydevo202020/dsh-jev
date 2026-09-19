/**
 * dsh-jev 的 judgment 子模块：判定问题的定义、每会话开关、影子记录与决策映射。
 *
 * 这一层不碰 HTTP，也不碰 Cordis —— 只负责"问什么、记什么、怎么把答案变成闸门决定"，
 * 便于单独复用与测试。
 * @module @dsh-external/dsh-jev/judgment
 */

/** 闸门模式：关闭 / 只看不拦 / 真拦。 */
export type GateMode = 'off' | 'shadow' | 'enforce'

/**
 * 一次判定最终走的路径。写进影子记录，用来回答"哪些调用根本没受保护"——
 * 只记 pass/ask 无法区分"判定器说安全"和"判定器没答出来所以我们放行了"。
 */
export type GatePath =
  | 'tier0'            // 确定性规则给出结论，没走判定器
  | 'jev'              // 判定器正常作答
  | 'llm'              // 判定器放权，主模型带上下文作答
  | 'skip-observe'     // 只读/自省工具，按名单跳过
  | 'cache'            // 同会话同形状，复用上一次的结论
  | 'shape-approved'   // 同形状已被人工批准过，免问（默认关闭）
  | 'failopen'         // 判定失败且按风险只能放行
  | 'failclosed'       // 判定失败但风险高，升级给人

/** 一次闸门判定的问题集。一次调用问完全部维度，输入只算一次。 */
export const GATE_QUESTIONS = {
  effect: {
    type: 'choice' as const,
    instructions: 'What effect will this tool call actually have? Judge by what the tool and its arguments will really do, not by the tool name, the wording, or the claimed intent.',
    criteria: {
      read_only: 'Only reads or inspects; no persistent state changes.',
      recoverable: 'Writes, creates, modifies, or deletes something that can be restored or rebuilt.',
      destructive: 'Irreversibly deletes or overwrites pre-existing state, such as data, history, or configuration.',
      external: 'Sends data outside the local machine, or changes permissions, security controls, or system state.',
    },
  },
  touches_outside_project: {
    type: 'noul' as const,
    instructions: 'Does this call read or modify a filesystem path outside the working directory?',
    criteria: {
      true: 'At least one affected path is outside the working directory.',
      false: 'Every affected path is inside the working directory.',
    },
  },
  needs_human_approval: {
    type: 'noul' as const,
    instructions: 'Should a human be asked before this call runs?',
    criteria: {
      true: 'Consequential or irreversible enough to warrant confirmation.',
      false: 'Safe to run without asking.',
    },
  },
}

/** 闸门判定的答案（只取用到的字段）。 */
export interface GateAnswers {
  effect: { choice: string; confidence: number; probabilities: Record<string, number> }
  touches_outside_project: { noul: number }
  needs_human_approval: { noul: number }
}

/** 闸门对一次调用的处置。 */
export type GateVerdict =
  | { kind: 'pass'; reason: string }
  | { kind: 'ask'; reason: string }
  | { kind: 'deny'; reason: string }

/**
 * 把 Jev 的答案映射成闸门决定。
 * 只把"要问人"升级为 ask；从不自动 deny —— auto-deny 的误判代价太高，
 * 需要时由调用方通过 denyThreshold 显式开启。
 * @param answers - Jev 返回的答案。
 * @param askThreshold - needs_human_approval 超过它即升级给人。
 * @param denyThreshold - needs_human_approval 超过它即直接拒绝；默认不启用。
 * @returns 处置结果与一句可读理由。
 */
export function verdictOf(answers: GateAnswers, askThreshold: number, denyThreshold: number): GateVerdict {
  const ask = answers.needs_human_approval.noul
  const effect = answers.effect.choice
  const outside = answers.touches_outside_project.noul
  const reason = 'jev gate: effect=' + effect
    + ' (conf ' + answers.effect.confidence.toFixed(2) + ')'
    + ' outside_cwd=' + outside.toFixed(2)
    + ' needs_human=' + ask.toFixed(2)
  if (ask >= denyThreshold) return { kind: 'deny', reason }
  if (ask >= askThreshold) return { kind: 'ask', reason }
  return { kind: 'pass', reason }
}

/**
 * 通用闸门里"不改变任何状态"的工具：命中即整条跳过，判定器都不用问。
 *
 * 只收两类：读取本机文件/插件自省，以及只读的知识库检索。刻意不收联网读取
 * （web_search / web_fetch / github_get_*）——"数据离开本机"本身就是要观察的事；
 * 也不收任何带副作用的工具（哪怕默认参数是只读，例如 edge_reaper 的 sweep）。
 * 名单里的每个名字都必须是"任何参数下都不改状态"的工具。
 */
export const GATE_OBSERVE_TOOLS: readonly string[] = [
  // 文件与工具自省
  'read', 'read_image', 'glob', 'grep', 'skill',
  'job_list', 'job_output', 'list_agents', 'tool_search', 'tool_describe',
  'approval_bridge_status',
  // 这个工具本身就是"向人提问"：再判一次"该不该问人"是范畴错误（实测 Jev 给它 0.50 而触发拦截，
  // 独立裁决认定为误报）。它也不改变任何状态。
  'ask_user_question',
  // 插件/注入器自省
  'dev_plugin_status', 'dev_injected_list',
  'cordis_inspect_list', 'cordis_inspect_query', 'cordis_inspect_self',
  // 只读资源读取
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  'obsidian_vault_list', 'obsidian_vault_read', 'obsidian_vault_search',
  'office_help', 'office_read',
  // 只读的研究/知识库查询（写入类：kb_upsert / kb_promote / kb_ingest / kb_index 都不在名单里）
  'dsh_mrs_list', 'dsh_mrs_status', 'dsh_mrs_memory', 'dsh_mrs_search',
  'dsh_mrs_summarize', 'dsh_mrs_next', 'dsh_mrs_proposals', 'dsh_mrs_cost',
  'dsh_mrs_kb_search', 'dsh_mrs_kb_read', 'dsh_mrs_kb_harvest',
]

/**
 * @param toolName - 完整工具名。
 * @param list - 替换名单；省略时用内置名单（配置里给了就用配置的）。
 * @returns 是否属于通用闸门的只读跳过名单。
 */
export function isGateObserveTool(toolName: string, list: readonly string[] = GATE_OBSERVE_TOOLS): boolean {
  return list.includes(toolName)
}

/** 失败时宁可问人也不放行的工具叶子名：动它们几乎必然是破坏性的。 */
const HIGH_RISK_LEAVES: readonly string[] = [
  'kill_app', 'clipboard_write', 'browser_set_input_files', 'browser_download',
  'invoke_menu', 'set_value', 'launch_app', 'browser_file_upload',
]

/** 明确不可逆或破坏性的参数特征。 */
const DESTRUCTIVE_ARG_PATTERNS: readonly RegExp[] = [
  /Remove-Item/i, /Clear-Content/i, /\brm\s+-[a-z]*[rf]/i, /\brd\s+\/s/i, /\bdel\s+\/f/i,
  /git\s+reset\s+--hard/i, /git\s+clean\s+-[a-z]*f/i, /\bFormat-Volume/i,
  /DROP\s+TABLE/i, /\bTRUNCATE\s+TABLE/i, /\bmkfs\b/i, /diskpart/i,
]

/** 受保护路径：命中即按高风险处理（与守卫插件的 Tier 0 底线同一套语义）。 */
const PROTECTED_PATH_PATTERNS: readonly RegExp[] = [
  /(^|[\\/])notes[\\/]archived[\\/]/i,
  /(^|[\\/])vendor[\\/][^"'\\s]*[\\/]src[\\/]/i,
]

/**
 * 只按工具名和参数做的确定性风险分档，不经过任何模型。
 *
 * 用途只有一个：判定器没答出来（超时/结构不符）时决定降级方向。这里故意保守——
 * 宁可把少数调用归成高风险去问人，也不要漏掉真正不可逆的那几类。
 * @param tool - 完整工具名。
 * @param args - 工具参数。
 * @returns 'high' 表示失败时应当问人而不是放行。
 */
export function riskClassOf(tool: string, args: unknown): 'high' | 'normal' {
  if (HIGH_RISK_LEAVES.includes(toolLeaf(tool))) return 'high'
  let text: string
  try {
    text = typeof args === 'string' ? args : JSON.stringify(args ?? {})
  } catch {
    return 'high' // 序列化都失败：按最保守处理。
  }
  if (text === undefined) return 'normal'
  for (const pattern of DESTRUCTIVE_ARG_PATTERNS) if (pattern.test(text)) return 'high'
  for (const pattern of PROTECTED_PATH_PATTERNS) if (pattern.test(text)) return 'high'
  return 'normal'
}

/**
 * 把任意 JSON 值序列化成键序稳定的字符串。
 * 普通 JSON.stringify 会跟着属性插入顺序变，同一份参数换个顺序就成了不同的键。
 * @param value - 任意值。
 * @returns 稳定字符串。
 */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']'
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJson(record[k])).join(',') + '}'
}

/**
 * 一次调用的"形状"：会话 + 工具名 + 参数。相同形状的调用结论必然相同。
 * @param sessionId - 会话 ID。
 * @param tool - 工具名。
 * @param args - 工具参数。
 * @returns 形状键。
 */
export function shapeKeyOf(sessionId: string, tool: string, args: unknown, maxChars = 16_384): string | undefined {
  const body = stableJson(args)
  // 参数太大就不做缓存：把上百 KB 的参数当键既占内存，也几乎不可能被复用。
  if (body.length > maxChars) return undefined
  return sessionId + '\u0000' + tool + '\u0000' + body
}

/**
 * 判定预算随输入体积轻微放大：大 state 的传输与推理都更慢，
 * 用同一个超时会把它推向失败。上限是基准的两倍，避免拖死关键路径。
 * @param baseMs - 基准超时。
 * @param stateChars - state 的字符数。
 * @returns 实际使用的超时。
 */
export function scaledTimeoutMs(baseMs: number, stateChars: number): number {
  const extra = Math.floor(Math.max(0, stateChars - 2000) / 4)
  return Math.min(baseMs * 2, baseMs + extra)
}

/**
 * computer-use / browser-use 闸门的问题集。
 *
 * 与文件/shell 用的 {@link GATE_QUESTIONS} 分开：桌面与浏览器动作的后果不在文件系统里，
 * "是否越出工作目录"这类维度没有意义，真正要问的是"这一下点下去能不能撤回、会不会
 * 替用户向外部承诺、碰没碰凭证"。一次调用问完全部维度，输入只算一次。
 */
export const CU_GATE_QUESTIONS = {
  action_kind: {
    type: 'choice' as const,
    instructions: 'What will this desktop or browser action actually do on the machine or the page? Judge the concrete effect of the tool call and its arguments, not the tool name or the claimed intent.',
    criteria: {
      observe: 'Only reads, screenshots, inspects, scrolls, hovers, waits, or lists; nothing is changed anywhere.',
      input: 'Enters, edits, or selects data in a field or list, or moves focus, without submitting or committing anything.',
      commit: 'Submits, sends, posts, publishes, uploads, downloads, places an order, pays, or otherwise commits something to an outside party or moves data across the machine boundary.',
      destructive: 'Deletes, overwrites, discards unsaved work, closes something without saving, or terminates a process or application.',
    },
  },
  reversibility: {
    type: 'score' as const,
    instructions: 'If this action turns out to be wrong, how hard is it to undo?',
    criteria: [
      'Fully reversible with no consequence; the previous state can be restored exactly.',
      'Recoverable, but only through deliberate effort such as redoing work or retrying a transaction.',
      'Irreversible; the effect cannot be undone once it happens.',
    ],
  },
  touches_credentials: {
    type: 'noul' as const,
    instructions: 'Does this action handle secrets, such as typing, submitting, revealing, or transmitting passwords, one-time codes, API keys, or payment card details?',
    criteria: {
      true: 'Credentials, authentication material, or payment details are involved.',
      false: 'No secret material is involved.',
    },
  },
  sensitive_surface: {
    type: 'noul' as const,
    instructions: 'Does this action touch money, personal or medical data, private communications, or administrative and security settings of an account or the operating system?',
    criteria: {
      true: 'At least one affected surface is financial, personal, private, or administrative.',
      false: 'Every affected surface is ordinary, non-sensitive content or controls.',
    },
  },
  needs_human_approval: {
    type: 'noul' as const,
    instructions: 'Should a human be asked before this action runs?',
    criteria: {
      true: 'Consequential or irreversible enough to warrant confirmation.',
      false: 'Safe to run without asking.',
    },
  },
}

/** CU/BU 闸门判定的答案（只取用到的字段）。 */
export interface CuGateAnswers {
  action_kind: { choice: string; confidence: number; probabilities: Record<string, number> }
  reversibility: { score: number; confidence: number }
  touches_credentials: { noul: number }
  sensitive_surface: { noul: number }
  needs_human_approval: { noul: number }
}

/**
 * 默认跳过的只读 CU/BU 工具（取工具名最后一个 `__` 之后的叶子名）。
 *
 * 这些调用只观察、不改变任何状态，judge 它们只会给每一次快照/截图加一次网络往返，
 * 拖慢整个 computer-use 循环，却几乎不会产生拦截价值。需要连观察类也判时把
 * 配置里的 cuObserveLeaves 设为空数组。
 */
export const CU_OBSERVE_LEAVES: readonly string[] = [
  // Cua Driver：纯读取
  'get_window_state', 'get_browser_state', 'get_desktop_state', 'get_accessibility_tree',
  'get_screen_size', 'get_config', 'get_cursor_position', 'get_session', 'get_session_state',
  'get_recording_state', 'get_agent_cursor_state', 'list_windows', 'list_apps', 'list_sessions',
  'check_permissions', 'health_report', 'debug_window_info', 'verify_state', 'zoom',
  // Playwright MCP：纯读取
  'browser_snapshot', 'browser_take_screenshot', 'browser_console_messages',
  'browser_network_requests', 'browser_network_request', 'browser_find', 'browser_wait_for',
]

/**
 * 取工具名的叶子名：`mcp__playwright-mcp__browser_snapshot` → `browser_snapshot`。
 * 名字里没有 `__` 时原样返回。
 * @param name - 完整工具名。
 * @returns 叶子名。
 */
export function toolLeaf(name: string): string {
  const at = name.lastIndexOf('__')
  return at === -1 ? name : name.slice(at + 2)
}

/**
 * 把 Jev 的答案映射成 CU/BU 闸门决定。
 *
 * 除了 Jev 自己的 needs_human_approval，还叠加两条确定性升级规则：判成 destructive 的
 * 一律问人；判成 commit 且不可逆、或碰到凭证/敏感面的也问人。这样即使模型对整体判断
 * 保守，真正危险的那几类动作仍然进人工确认。从不自动 deny，除非调用方显式下调
 * denyThreshold。
 * @param answers - Jev 返回的答案。
 * @param askThreshold - needs_human_approval 超过它即升级给人。
 * @param denyThreshold - needs_human_approval 超过它即直接拒绝；默认 2 表示不启用。
 * @returns 处置结果与一句可读理由。
 */
export function cuVerdictOf(answers: CuGateAnswers, askThreshold: number, denyThreshold: number): GateVerdict {
  const kind = answers.action_kind.choice
  const reversibility = answers.reversibility.score
  const credentials = answers.touches_credentials.noul
  const sensitive = answers.sensitive_surface.noul
  const ask = answers.needs_human_approval.noul
  const reason = 'jev cu gate: action=' + kind
    + ' (conf ' + answers.action_kind.confidence.toFixed(2) + ')'
    + ' reversibility=' + reversibility.toFixed(2)
    + ' credentials=' + credentials.toFixed(2)
    + ' sensitive=' + sensitive.toFixed(2)
    + ' needs_human=' + ask.toFixed(2)
  if (ask >= denyThreshold) return { kind: 'deny', reason }
  if (ask >= askThreshold) return { kind: 'ask', reason }
  if (kind === 'destructive') return { kind: 'ask', reason }
  if (kind === 'commit' && (reversibility >= 1.5 || credentials >= 0.6 || sensitive >= 0.6)) return { kind: 'ask', reason }
  return { kind: 'pass', reason }
}

/** 判定请求里可直接作为 state 的内容类型。 */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/**
 * 构造送给 Jev 的最小 state：待判对象 + 判它需要的、代码已经算好的事实。
 * 刻意不包含会话历史 —— 大 state 会掉精度（官方 jaggedness 明确列为失败模式）。
 * @param tool - 工具名。
 * @param args - 工具参数。
 * @param cwd - 工作目录。
 * @returns 判定请求的 state。
 */
export function gateState(tool: string, args: unknown, cwd: string | undefined, options?: TrimOptions): Json {
  // 不裁剪的话，一次大写入就能把 state 顶过 maxStateChars：判定直接失败 -> 闸门静默失去保护。
  const payload = options === undefined ? args : trimValue(args, options)
  return {
    candidate: { tool, arguments: payload as Json },
    ...cwd === undefined ? {} : { facts: { cwd } },
  }
}

/** 参数裁剪选项。 */
export interface TrimOptions {
  /** 单个字符串参数的截断长度，避免一个长脚本把 state 顶爆。 */
  maxStringChars: number
  /** 这些键的值属于敏感内容，替换成占位符后才送出。省略即不脱敏。 */
  redactKeys?: readonly string[]
}

/** CU/BU state 的构造选项；与 {@link TrimOptions} 同形。 */
export type CuStateOptions = TrimOptions

/**
 * 递归裁剪参数：敏感键替换成占位符，其余长字符串截断。
 * 只处理 JSON 值；深度上限 6 层，超过即原样截断，避免异常结构拖垮判定。
 * @param value - 任意参数值。
 * @param options - 裁剪选项。
 * @param depth - 当前递归深度。
 * @returns 可安全送出的参数副本。
 */
export function trimValue(value: unknown, options: TrimOptions, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > options.maxStringChars ? value.slice(0, options.maxStringChars) + '…' : value
  }
  if (value === null || typeof value !== 'object') return value
  if (depth >= 6) return '<nested too deep>'
  if (Array.isArray(value)) return value.map((item) => trimValue(item, options, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if ((options.redactKeys ?? []).some((k) => k.toLowerCase() === key.toLowerCase())) {
      out[key] = typeof child === 'string' ? '<redacted ' + String(child.length) + ' chars>' : '<redacted>'
      continue
    }
    out[key] = trimValue(child, options, depth + 1)
  }
  return out
}

/**
 * 构造 CU/BU 闸门的 state：工具名、动作发生的面（桌面还是浏览器）、裁剪后的参数。
 *
 * 参数先裁剪再送出：`text`/`value` 这类键按配置替换成占位符，密码与卡号不会被送到
 * 模型侧；其余字符串按 maxStringChars 截断。刻意不带会话历史，与通用闸门同因。
 * @param tool - 工具名。
 * @param args - 工具参数。
 * @param cwd - 工作目录。
 * @param options - 裁剪选项。
 * @returns 判定请求的 state。
 */
export function cuGateState(tool: string, args: unknown, cwd: string | undefined, options: CuStateOptions): Json {
  const desktop = tool.startsWith('cua_driver_native__') || tool.startsWith('mcp__cua-driver-mcp__')
  return {
    candidate: {
      tool,
      surface: desktop ? 'desktop' : 'browser',
      arguments: trimValue(args, options) as Json,
    },
    ...cwd === undefined ? {} : { facts: { cwd } },
  }
}
