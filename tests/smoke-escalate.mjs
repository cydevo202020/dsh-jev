
// 阶段 3 的离线冒烟：放权触发条件、上下文快照、输出解析，以及闸门端的接管行为。
import { apply } from '../lib/index.js'
import { escalateTriggerOf, escalationPrompt, inputLooksThin, parseEscalationDecision, sessionDigest } from '../lib/escalate.js'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TYPESAFE_API_KEY_SMOKE = 'smoke-key'
const out = []
const ok = (cond, label) => { out.push((cond ? 'PASS ' : 'FAIL ') + label); return cond }

function mount(overrides = {}, llm) {
  const dir = mkdtempSync(join(tmpdir(), 'jev-esc-'))
  const cap = { tools: {}, pre: [], post: [], fetches: 0, llmCalls: 0, prompts: [] }
  const ctx = {
    provide: () => {},
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    get: (n) => (n === 'llm' ? llm : undefined),
    tools: { register: (t) => { cap.tools[t.name] = t; return () => {} } },
    on: (name, handler) => {
      if (name === 'tools/pre-execute') cap.pre.push(handler)
      if (name === 'tools/post-execute') cap.post.push(handler)
      return () => {}
    },
  }
  const config = {
    apiKeyEnv: 'TYPESAFE_API_KEY_SMOKE', credentialsPath: 'C:/definitely/missing.yaml',
    baseURL: 'https://api.typesafe.ai', model: 'jev-latest',
    timeoutMs: 5000, maxStateChars: 40000, maxRetries: 0,
    gateDefaultMode: 'off', gateAskThreshold: 0.5, gateDenyThreshold: 2, gateTimeoutMs: 3000,
    gateStateFile: join(dir, 'state.json'), gateShadowDir: dir, gatePreviewChars: 80,
    cuGateDefaultMode: 'shadow', cuGateStateFile: join(dir, 'cu-state.json'),
    ...overrides,
  }
  apply(ctx, config)
  const run = (exec, base = async () => ({ kind: 'allow' })) => {
    const dispatch = (i) => async () => (i < cap.pre.length ? cap.pre[i](exec, dispatch(i + 1)) : base())
    return dispatch(0)()
  }
  return { dir, cap, run, tools: cap.tools }
}

const exec = (name, args = {}, sessionId = 'S1', parent = undefined) =>
  ({ name, arguments: args, parent, callId: 'cc' + Math.random().toString(36).slice(2, 8), signal: AbortSignal.timeout(9000), agent: { session: { id: sessionId } } })

const cuAnswers = (over = {}) => ({
  action_kind: { type: 'choice', choice: 'observe', confidence: 0.9, probabilities: {}, ...(over.action_kind ?? {}) },
  reversibility: { type: 'score', score: 0, confidence: 0.9, ...(over.reversibility ?? {}) },
  touches_credentials: { type: 'noul', noul: 0.05 },
  sensitive_surface: { type: 'noul', noul: 0.05 },
  needs_human_approval: { type: 'noul', noul: 0.05, ...(over.needs_human_approval ?? {}) },
})
const gateAnswers = (over = {}) => ({
  effect: { type: 'choice', choice: 'recoverable', confidence: 0.9, probabilities: {}, ...(over.effect ?? {}) },
  touches_outside_project: { type: 'noul', noul: 0.1 },
  needs_human_approval: { type: 'noul', noul: 0.05, ...(over.needs_human_approval ?? {}) },
})
const mockJev = (cap, answers) => {
  globalThis.fetch = async () => { cap.fetches++; return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 100, output_tokens: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } }) }
}
const mockLlm = (cap, reply) => {
  const svc = {
    stream: (options) => {
      cap.llmCalls++
      try { cap.prompts.push(JSON.parse(JSON.stringify(options))?.messages?.[0]?.content?.[0]?.text ?? '') } catch { cap.prompts.push('') }
      return (async function* () {
        if (typeof reply === 'string') yield { type: 'text-delta', index: 0, text: reply }
        else for (const piece of reply) yield { type: 'text-delta', index: 0, text: piece }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  return svc
}
const recs = (dir, prefix = '') => {
  const f = readdirSync(dir).filter((x) => x.startsWith(prefix + 'shadow-'))[0]
  return f === undefined ? [] : readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

// ---------- 1. 输入是否"没说清楚" ----------
out.push('=== 1. U1 信息不足 ===')
ok(inputLooksThin({ filename: 'C:\\\\Temp\\\\dsh-2048-step-1.js' }), '只有一个文件路径 -> 信息不足（2048 的真实案例）')
ok(inputLooksThin({ pid: 42, element_index: 4 }), '只有数字参数 -> 信息不足')
ok(inputLooksThin({ ref: 'p3:12', text: '<redacted 14 chars>' }), '值被脱敏 -> 信息不足')
ok(inputLooksThin({}), '空参数 -> 信息不足')
ok(!inputLooksThin({ code: 'async (page) => { return await page.evaluate(() => 1) }' }), '带代码的参数 -> 不算信息不足')
ok(!inputLooksThin({ command: 'node tests/smoke.mjs' }), '带命令的参数 -> 不算信息不足')

out.push('')
out.push('=== 2. 触发条件 ===')
ok(escalateTriggerOf({ tool: 'x', args: { filename: 'a.js' }, verdict: 'ask', summary: {}, margin: 0.1, lowConfidence: 0.5, enableLowConfidence: false }) === 'U1', '信息不足 -> U1')
ok(escalateTriggerOf({ tool: 'x', args: { command: 'echo a b' }, verdict: undefined, summary: {}, margin: 0.1, lowConfidence: 0.5, enableLowConfidence: false }) === 'U5', '判定失败 -> U5')
ok(escalateTriggerOf({ tool: 'x', args: { command: 'echo a b' }, verdict: 'ask', summary: { score: 0.55, threshold: 0.5 }, margin: 0.1, lowConfidence: 0.5, enableLowConfidence: false }) === 'U2', '贴着分数线 -> U2')
ok(escalateTriggerOf({ tool: 'x', args: { command: 'echo a b' }, verdict: 'ask', summary: { score: 0.9, threshold: 0.5 }, margin: 0.1, lowConfidence: 0.5, enableLowConfidence: false, dimensions: { effect: 'read_only', touches_outside_project: 0.9 } }) === 'U3', '"只读"却"出界很高" -> U3')
ok(escalateTriggerOf({ tool: 'x', args: { command: 'echo a b' }, verdict: 'pass', summary: { score: 0.05, threshold: 0.5 }, margin: 0.1, lowConfidence: 0.5, enableLowConfidence: false }) === undefined, '结论干净利落 -> 不放权')
ok(escalateTriggerOf({ tool: 'x', args: { command: 'echo a b' }, verdict: 'pass', summary: { score: 0.05, threshold: 0.5 }, margin: 0.1, lowConfidence: 0.9, enableLowConfidence: true, dimensions: { confidence: 0.4 } }) === 'U4', '显式打开后低置信 -> U4')
// U1 收紧：参数信息不足、但判定器自信放行时不再放权（实测这条规则 299 次触发里 276 次是白花的）
ok(escalateTriggerOf({ tool: 'x', args: { packageName: 'some-pkg' }, verdict: 'pass', summary: { score: 0.05, threshold: 0.5 }, margin: 0.1, lowConfidence: 0.5, enableLowConfidence: false, dimensions: { confidence: 0.95 } }) === undefined, '信息不足 + 自信放行 -> 不放权')
ok(escalateTriggerOf({ tool: 'x', args: { packageName: 'some-pkg' }, verdict: 'pass', summary: { score: 0.05, threshold: 0.5 }, margin: 0.1, lowConfidence: 0.5, enableLowConfidence: false, dimensions: { confidence: 0.4 } }) === 'U1', '信息不足 + 判定器没底 -> U1')
ok(escalateTriggerOf({ tool: 'x', args: { packageName: 'some-pkg' }, verdict: 'pass', summary: { score: 0.05, threshold: 0.5 }, margin: 0.1, lowConfidence: 0.5, enableLowConfidence: false, dimensions: { confidence: 0.95 }, thinConfidence: 0.99 }) === 'U1', '门槛调高后同样情形重新放权')
ok(escalateTriggerOf({ tool: 'x', args: { filename: 'a.js' }, verdict: undefined, summary: {}, margin: 0.1, lowConfidence: 0.5, enableLowConfidence: false }) === 'U5', '判定失败优先记 U5，不再记成 U1')

out.push('')
out.push('=== 3. 输出解析 ===')
ok(parseEscalationDecision('{"decision":"allow","risk":"low","reason":"reading the board"}')?.decision === 'allow', '标准输出')
ok(parseEscalationDecision('前言 {"decision":"deny","risk":"high","reason":"删除数据"} 后语')?.decision === 'deny', '前后有多余文字也能解析')
ok(parseEscalationDecision('{"decision":"ask","reason":"a {brace} inside"}')?.decision === 'ask', '字符串里有花括号也能解析')
ok(parseEscalationDecision('{"decision":"maybe"}') === undefined, '非法取值 -> undefined')
ok(parseEscalationDecision('no json at all') === undefined, '没有 JSON -> undefined')
ok(parseEscalationDecision('{"reason":"x"}{"decision":"allow"}')?.decision === 'allow', '取最后一个合法对象')

out.push('')
out.push('=== 4. 上下文快照 ===')
const fakeSession = {
  snapshotEvents: () => [
    { type: 'user/message', data: { source: { kind: 'plugin' }, message: { content: [{ type: 'text', text: '这是插件注入的技能目录，不该算用户指令' }] } } },
    { type: 'user/message', data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text: '帮我玩一局 2048' }] } } },
    { type: 'tool/call', data: { name: 'pwsh', arguments: { command: 'echo hi' } } },
    { type: 'user/message', data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text: '<system-reminder>框架文本</system-reminder>' }] } } },
    { type: 'user/message', data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text: '继续，下一步往左划' }] } } },
  ],
}
const digest = sessionDigest(fakeSession)
ok(digest.requests.length === 2, '只收真人指令、跳过插件注入与框架文本（实际 ' + digest.requests.length + ' 条）')
ok(digest.requests[0].includes('往左划'), '最新的指令排在最前')
ok(digest.calls.length === 1 && digest.calls[0].tool === 'pwsh', '收到最近的工具调用')
ok(sessionDigest(undefined).requests.length === 0 && sessionDigest({}).calls.length === 0, '没有会话对象时返回空快照且不报错')
ok(sessionDigest({ snapshotEvents: () => { throw new Error('boom') } }).requests.length === 0, '快照抛错时返回空快照')
const prompt = escalationPrompt({ tool: 'x', args: { a: 1 }, cwd: 'F:/w', trigger: 'U1', jevSummary: { verdict: 'ask', reason: 'r', score: 0.7, threshold: 0.5 }, digest, maxArgChars: 500 })
ok(prompt.includes('继续，下一步往左划') && prompt.includes('U1') && prompt.includes('F:/w'), '放权请求里带上了用户指令与触发条件')

// ---------- 5. 闸门端：2048 真实案例 ----------
out.push('')
out.push('=== 5. 闸门端接管（2048 场景）===')
{
  // mount() 在 apply 时就把 ctx.get 固定住了，所以这里单独搭一个带 llm 的实例。
  const m2 = (() => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-esc2-'))
    const c2 = { tools: {}, pre: [], post: [], fetches: 0, llmCalls: 0, prompts: [] }
    const ctx2 = {
      provide: () => {}, effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
      get: (n) => (n === 'llm' ? mockLlm(c2, '{"decision":"allow","risk":"low","reason":"只是在读取棋盘"}') : undefined),
      tools: { register: (t) => { c2.tools[t.name] = t; return () => {} } },
      on: (name, handler) => { if (name === 'tools/pre-execute') c2.pre.push(handler); if (name === 'tools/post-execute') c2.post.push(handler); return () => {} },
    }
    apply(ctx2, {
      apiKeyEnv: 'TYPESAFE_API_KEY_SMOKE', credentialsPath: 'C:/definitely/missing.yaml',
      baseURL: 'https://api.typesafe.ai', model: 'jev-latest',
      timeoutMs: 5000, maxStateChars: 40000, maxRetries: 0,
      gateDefaultMode: 'off', gateAskThreshold: 0.5, gateDenyThreshold: 2, gateTimeoutMs: 3000,
      gateStateFile: join(dir, 'state.json'), gateShadowDir: dir, gatePreviewChars: 80,
      cuGateDefaultMode: 'shadow', cuGateStateFile: join(dir, 'cu-state.json'),
      escalateMode: 'enforce',
    })
    const run2 = (e, base = async () => ({ kind: 'allow' })) => {
      const dispatch = (i) => async () => (i < c2.pre.length ? c2.pre[i](e, dispatch(i + 1)) : base())
      return dispatch(0)()
    }
    return { dir, cap: c2, run: run2, tools: c2.tools }
  })()

  await m2.tools['jev_gate'].execute({ action: 'enforce', gate: 'cu' }, { agent: { session: { id: 'S1' } } })
  mockJev(m2.cap, cuAnswers({ action_kind: { choice: 'destructive', confidence: 0.24 }, reversibility: { score: 0.8 }, needs_human_approval: { noul: 0.78 } }))
  const e = exec('mcp__playwright-mcp__browser_run_code_unsafe', { filename: 'C:\\\\Temp\\\\dsh-2048-step-1.js' })
  const r = await m2.run(e)
  ok(r.kind === 'allow', 'Jev 判"破坏"+问人，LLM 判"放行" -> 结果放行（kind=' + r.kind + '，这正是 2048 那次刷屏的修法）')
  ok(m2.cap.llmCalls === 1, '确实调用了一次 LLM 分类器')
  const rec = recs(m2.dir, 'cu-').filter((x) => x.path === 'llm').pop()
  ok(rec !== undefined && rec.escalate && rec.escalate.trigger === 'U1' && rec.escalate.decision === 'allow', '记录 path=llm 且 escalate.trigger=U1')
}

out.push('')
out.push('=== 6. shadow 不改处置 / 失败不影响调用 / 开关 / 上限 ===')
{
  // shadow：只记录
  const dir = mkdtempSync(join(tmpdir(), 'jev-esc3-'))
  const cap = { tools: {}, pre: [], post: [], fetches: 0, llmCalls: 0, prompts: [] }
  const ctx = {
    provide: () => {}, effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    get: (n) => (n === 'llm' ? mockLlm(cap, '{"decision":"allow","risk":"low","reason":"ok"}') : undefined),
    tools: { register: (t) => { cap.tools[t.name] = t; return () => {} } },
    on: (name, handler) => { if (name === 'tools/pre-execute') cap.pre.push(handler); return () => {} },
  }
  const base = {
    apiKeyEnv: 'TYPESAFE_API_KEY_SMOKE', credentialsPath: 'C:/definitely/missing.yaml',
    baseURL: 'https://api.typesafe.ai', model: 'jev-latest',
    timeoutMs: 5000, maxStateChars: 40000, maxRetries: 0,
    gateDefaultMode: 'off', gateAskThreshold: 0.5, gateDenyThreshold: 2, gateTimeoutMs: 3000,
    gateStateFile: join(dir, 'state.json'), gateShadowDir: dir, gatePreviewChars: 80,
    cuGateDefaultMode: 'shadow', cuGateStateFile: join(dir, 'cu-state.json'),
  }
  apply(ctx, { ...base, escalateMode: 'shadow' })
  const run = (e, b = async () => ({ kind: 'allow' })) => { const d = (i) => async () => (i < cap.pre.length ? cap.pre[i](e, d(i + 1)) : b()); return d(0)() }
  await cap.tools['jev_gate'].execute({ action: 'enforce' }, { agent: { session: { id: 'S1' } } })
  mockJev(cap, gateAnswers({ needs_human_approval: { noul: 0.9 } }))
  const r1 = await run(exec('write', { file_path: 'F:/x/esc-thin.ts' }))
  ok(r1.kind === 'ask', 'shadow 下 LLM 说放行也不改变处置（kind=' + r1.kind + '）')
  const rec1 = recs(dir).pop()
  ok(rec1.escalate !== null && rec1.escalate.mode === 'shadow' && rec1.escalate.decision === 'allow', 'shadow 下仍然记录了 LLM 的结论')

  // off：一次都不调
  const before = cap.llmCalls
  const dir4 = mkdtempSync(join(tmpdir(), 'jev-esc4-'))
  const cap4 = { tools: {}, pre: [], post: [], fetches: 0, llmCalls: 0, prompts: [] }
  const ctx4 = { ...ctx, get: (n) => (n === 'llm' ? mockLlm(cap4, '{"decision":"allow"}') : undefined),
    tools: { register: (t) => { cap4.tools[t.name] = t; return () => {} } },
    on: (name, handler) => { if (name === 'tools/pre-execute') cap4.pre.push(handler); return () => {} } }
  apply(ctx4, { ...base, escalateMode: 'off', gateStateFile: join(dir4, 'state.json'), gateShadowDir: dir4 })
  const run4 = (e) => { const d = (i) => async () => (i < cap4.pre.length ? cap4.pre[i](e, d(i + 1)) : { kind: 'allow' }); return d(0)() }
  await cap4.tools['jev_gate'].execute({ action: 'enforce' }, { agent: { session: { id: 'S1' } } })
  mockJev(cap4, gateAnswers({ needs_human_approval: { noul: 0.9 } }))
  await run4(exec('write', { file_path: 'F:/x/esc-thin.ts' }))
  ok(cap4.llmCalls === 0, 'escalateMode=off 时一次 LLM 都不调（实际 ' + cap4.llmCalls + '）')

  // llm 服务缺席
  const dir5 = mkdtempSync(join(tmpdir(), 'jev-esc5-'))
  const cap5 = { tools: {}, pre: [], fetches: 0 }
  const ctx5 = { require: undefined, provide: () => {}, effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    get: () => undefined, tools: { register: (t) => { cap5.tools[t.name] = t; return () => {} } },
    on: (name, handler) => { if (name === 'tools/pre-execute') cap5.pre.push(handler); return () => {} } }
  apply(ctx5, { ...base, escalateMode: 'enforce', gateStateFile: join(dir5, 'state.json'), gateShadowDir: dir5 })
  const run5 = (e) => { const d = (i) => async () => (i < cap5.pre.length ? cap5.pre[i](e, d(i + 1)) : { kind: 'allow' }); return d(0)() }
  await cap5.tools['jev_gate'].execute({ action: 'enforce' }, { agent: { session: { id: 'S1' } } })
  mockJev(cap5, gateAnswers({ needs_human_approval: { noul: 0.9 } }))
  const r5 = await run5(exec('write', { file_path: 'F:/x/esc-thin.ts' }))
  ok(r5.kind === 'ask', 'llm 服务缺席时按原结论走（kind=' + r5.kind + '）')
  const rec5 = recs(dir5).pop()
  ok(rec5.escalate && String(rec5.escalate.error).includes('llm 服务不可用'), '记录里写明 llm 服务不可用')

  // 协议不符
  const dir6 = mkdtempSync(join(tmpdir(), 'jev-esc6-'))
  const cap6 = { tools: {}, pre: [], fetches: 0, llmCalls: 0, prompts: [] }
  const ctx6 = { provide: () => {}, effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    get: (n) => (n === 'llm' ? mockLlm(cap6, '我觉得可以放行') : undefined),
    tools: { register: (t) => { cap6.tools[t.name] = t; return () => {} } },
    on: (name, handler) => { if (name === 'tools/pre-execute') cap6.pre.push(handler); return () => {} } }
  apply(ctx6, { ...base, escalateMode: 'enforce', gateStateFile: join(dir6, 'state.json'), gateShadowDir: dir6 })
  const run6 = (e) => { const d = (i) => async () => (i < cap6.pre.length ? cap6.pre[i](e, d(i + 1)) : { kind: 'allow' }); return d(0)() }
  await cap6.tools['jev_gate'].execute({ action: 'enforce' }, { agent: { session: { id: 'S1' } } })
  mockJev(cap6, gateAnswers({ needs_human_approval: { noul: 0.9 } }))
  const r6 = await run6(exec('write', { file_path: 'F:/x/esc-thin.ts' }))
  const rec6 = recs(dir6).pop()
  ok(r6.kind === 'ask' && rec6.escalate && String(rec6.escalate.error).includes('不符合协议'), '模型不按协议作答时退回原结论')

  // 上限
  const dir7 = mkdtempSync(join(tmpdir(), 'jev-esc7-'))
  const cap7 = { tools: {}, pre: [], fetches: 0, llmCalls: 0, prompts: [] }
  const ctx7 = { provide: () => {}, effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    get: (n) => (n === 'llm' ? mockLlm(cap7, '{"decision":"allow"}') : undefined),
    tools: { register: (t) => { cap7.tools[t.name] = t; return () => {} } },
    on: (name, handler) => { if (name === 'tools/pre-execute') cap7.pre.push(handler); return () => {} } }
  apply(ctx7, { ...base, escalateMode: 'enforce', escalateMaxPerSession: 1, gateStateFile: join(dir7, 'state.json'), gateShadowDir: dir7 })
  const run7 = (e) => { const d = (i) => async () => (i < cap7.pre.length ? cap7.pre[i](e, d(i + 1)) : { kind: 'allow' }); return d(0)() }
  await cap7.tools['jev_gate'].execute({ action: 'enforce' }, { agent: { session: { id: 'S1' } } })
  mockJev(cap7, gateAnswers({ needs_human_approval: { noul: 0.9 } }))
  await run7(exec('write', { file_path: 'F:/x/esc-cap-1.ts' }))
  await run7(exec('write', { file_path: 'F:/x/esc-cap-2.ts' }))
  ok(cap7.llmCalls === 1, '超过会话上限后不再放权（实际调用 ' + cap7.llmCalls + ' 次）')
  const rec7 = recs(dir7).pop()
  ok(rec7.escalate && String(rec7.escalate.error).includes('上限'), '记录里写明已达上限')
}

clearTimeout(void 0)
const failed = out.filter((l) => l.startsWith('FAIL'))
console.log(out.join('\n'))
console.log('')
console.log(failed.length === 0 ? '全部通过 (' + out.filter((l) => l.startsWith('PASS')).length + ' 项)' : failed.length + ' 项失败')
process.exitCode = failed.length === 0 ? 0 : 1
