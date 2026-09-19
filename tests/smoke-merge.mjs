
// 阶段 2 最后一项：其它插件把判定挂进同一次 Jev 调用。
import { apply } from '../lib/index.js'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TYPESAFE_API_KEY_SMOKE = 'smoke-key'
const out = []
const ok = (c, l) => { out.push((c ? 'PASS ' : 'FAIL ') + l); return c }

// 贡献者注册表是进程级的（这是刻意的：热重载后新实例仍要看得到注册）。所以每个 mount
// 之前先清空，模拟"干净进程"，否则上一段测试注册的贡献者会漏进下一段。
const clearContributors = () => {
  const registry = globalThis[Symbol.for('@dsh-external/dsh-jev:contributors')]
  if (registry instanceof Map) registry.clear()
}

function mount(overrides = {}) {
  clearContributors()
  const dir = mkdtempSync(join(tmpdir(), 'jev-merge-'))
  const provided = {}
  const cap = { tools: {}, pre: [], fetches: 0, bodies: [] }
  const ctx = {
    provide: (n, v) => { provided[n] = v },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    get: (n) => provided[n],
    tools: { register: (t) => { cap.tools[t.name] = t; return () => {} } },
    on: (name, handler) => { if (name === 'tools/pre-execute') cap.pre.push(handler); return () => {} },
  }
  apply(ctx, {
    apiKeyEnv: 'TYPESAFE_API_KEY_SMOKE', credentialsPath: 'C:/definitely/missing.yaml',
    baseURL: 'https://api.typesafe.ai', model: 'jev-latest',
    timeoutMs: 5000, maxStateChars: 40000, maxRetries: 0,
    gateDefaultMode: 'off', gateAskThreshold: 0.5, gateDenyThreshold: 2, gateTimeoutMs: 3000,
    gateStateFile: join(dir, 'state.json'), gateShadowDir: dir, gatePreviewChars: 80,
    cuGateDefaultMode: 'shadow', cuGateStateFile: join(dir, 'cu-state.json'),
    ...overrides,
  })
  const run = (exec) => { const d = (i) => async () => (i < cap.pre.length ? cap.pre[i](exec, d(i + 1)) : { kind: 'allow' }); return d(0)() }
  return { dir, cap, provided, run, tools: cap.tools }
}
const exec = (name, args, sessionId = 'S1') => ({ name, arguments: args, callId: 'c' + Math.random().toString(36).slice(2, 8), signal: AbortSignal.timeout(9000), agent: { session: { id: sessionId } } })

let nextAnswers = {
  effect: { type: 'choice', choice: 'read_only', confidence: 0.99, probabilities: {} },
  touches_outside_project: { type: 'noul', noul: 0.1 },
  needs_human_approval: { type: 'noul', noul: 0.05 },
}
const mockJev = (cap) => {
  globalThis.fetch = async (_url, init) => {
    cap.fetches++
    cap.bodies.push(JSON.parse(String(init?.body ?? '{}')))
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: nextAnswers, usage: { input_tokens: 100, output_tokens: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}
const recs = (dir) => {
  const f = readdirSync(dir).filter((x) => x.startsWith('shadow-'))[0]
  return f === undefined ? [] : readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}
const contributor = (over = {}) => (input) => ({
  questions: over.questions ?? [{ id: 'scope_ok', type: 'noul', instructions: 'in scope?', criteria: { true: 'yes', false: 'no' } }],
  ...over.state === undefined ? {} : { state: over.state },
  settle: over.settle ?? ((answers) => ({ kind: 'deny', reason: '贡献者说不许', effective: true })),
})

out.push('=== 1. 一次调用问完两组问题 ===')
{
  const m = mount()
  await m.tools['jev_gate'].execute({ action: 'enforce' }, { agent: { session: { id: 'S1' } } })
  mockJev(m.cap)
  m.provided.jevGate.contribute('fake-warden', contributor({ state: { frozen_brief: { text: '冻结简报正文' } } }))
  const r = await m.run(exec('write', { file_path: 'F:/w/a.ts', content: 'x y z' }))
  ok(m.cap.fetches === 1, '一次调用发出一次请求（fetches=' + m.cap.fetches + '）')
  const qs = Object.keys(m.cap.bodies[0].questions)
  ok(qs.includes('effect') && qs.includes('needs_human_approval'), '闸门自己的问题在：' + qs.join(','))
  ok(qs.includes('scope_ok'), '贡献者的问题也在同一次请求里')
  ok(JSON.stringify(m.cap.bodies[0].state).includes('冻结简报正文'), '贡献者的 state 字段并进了同一个 state')
  ok(r.kind === 'deny', '贡献者的 deny 生效（kind=' + r.kind + '）')
  const rec = recs(m.dir).pop()
  ok(Array.isArray(rec.contrib) && rec.contrib[0].id === 'fake-warden', '记录里带上贡献者结论：' + JSON.stringify(rec.contrib))
}

out.push('')
out.push('=== 2. 影子贡献者只记录，不改变处置 ===')
{
  const m = mount()
  await m.tools['jev_gate'].execute({ action: 'enforce' }, { agent: { session: { id: 'S1' } } })
  mockJev(m.cap)
  m.provided.jevGate.contribute('shadow-contrib', contributor({ settle: () => ({ kind: 'deny', reason: '我想拒但我是影子', effective: false }) }))
  const r = await m.run(exec('write', { file_path: 'F:/w/b.ts', content: 'a b c' }))
  ok(r.kind === 'allow', '影子贡献者不改处置（kind=' + r.kind + '）')
  const rec = recs(m.dir).pop()
  ok(rec.contrib[0].effective === false && rec.contrib[0].kind === 'deny', '记录里仍能看到它的结论与「不生效」标记')
}

out.push('')
out.push('=== 3. 闸门模式为 off 时仍替贡献者判定 ===')
{
  const m = mount()
  mockJev(m.cap)
  m.provided.jevGate.contribute('only-contrib', contributor())
  const r = await m.run(exec('write', { file_path: 'F:/w/c.ts', content: 'a b c' }))
  ok(m.cap.fetches === 1, '模式 off 但有贡献者 -> 仍然问一次（fetches=' + m.cap.fetches + '）')
  ok(r.kind === 'deny', '处置来自贡献者（kind=' + r.kind + '）')
  const rec = recs(m.dir).pop()
  ok(rec.path === 'jev', '记录 path=jev，说明判定确实发生了')
}

out.push('')
out.push('=== 4. 没有贡献者时行为不变 ===')
{
  const m = mount()
  mockJev(m.cap)
  const r = await m.run(exec('write', { file_path: 'F:/w/d.ts', content: 'a b c' }))
  ok(m.cap.fetches === 0 && r.kind === 'allow', '模式 off 且无贡献者 -> 零请求零记录（fetches=' + m.cap.fetches + '）')
  ok(recs(m.dir).length === 0, '一条记录都不写')
}
{
  const m = mount()
  mockJev(m.cap)
  await m.run(exec('read', { file_path: 'F:/w/e.ts' }))
  ok(m.cap.fetches === 0, '只读工具仍然跳过（无请求）')
}

out.push('')
out.push('=== 5. 贡献者出错不能拖垮闸门 ===')
{
  const m = mount()
  await m.tools['jev_gate'].execute({ action: 'enforce' }, { agent: { session: { id: 'S1' } } })
  mockJev(m.cap)
  m.provided.jevGate.contribute('broken-factory', () => { throw new Error('factory boom') })
  const r1 = await m.run(exec('write', { file_path: 'F:/w/f.ts', content: 'a b c' }))
  ok(r1.kind === 'allow' && m.cap.fetches === 1, '工厂抛错的贡献者被跳过，闸门自己照常判定')
  m.provided.jevGate.contribute('broken-settle', contributor({ settle: () => { throw new Error('settle boom') } }))
  const r2 = await m.run(exec('write', { file_path: 'F:/w/g.ts', content: 'a b c' }))
  ok(r2.kind === 'allow', '结算抛错的贡献者被跳过，闸门自己的通过结论生效')
}

out.push('')
out.push('=== 6. 注销与 CU 闸门 ===')
{
  const m = mount()
  await m.tools['jev_gate'].execute({ action: 'enforce' }, { agent: { session: { id: 'S1' } } })
  mockJev(m.cap)
  const dispose = m.provided.jevGate.contribute('temp', contributor())
  await m.run(exec('write', { file_path: 'F:/w/h.ts', content: 'a b c' }))
  ok(m.cap.fetches === 1, '注册后参与判定')
  dispose()
  await m.run(exec('write', { file_path: 'F:/w/i.ts', content: 'a b c' }))
  ok(m.cap.fetches === 2, '注销后不再追加问题（仍然是闸门自己的一次调用）')
  const last = m.cap.bodies[m.cap.bodies.length - 1]
  ok(!Object.keys(last.questions).includes('scope_ok'), '注销后的问题集里没有贡献者的问题')
}
{
  const m = mount()
  await m.tools['jev_gate'].execute({ action: 'enforce', gate: 'cu' }, { agent: { session: { id: 'S1' } } })
  nextAnswers = {
    action_kind: { type: 'choice', choice: 'observe', confidence: 0.9, probabilities: {} },
    reversibility: { type: 'score', score: 0, confidence: 0.9 },
    touches_credentials: { type: 'noul', noul: 0.05 },
    sensitive_surface: { type: 'noul', noul: 0.05 },
    needs_human_approval: { type: 'noul', noul: 0.05 },
  }
  mockJev(m.cap)
  m.provided.jevGate.contribute('cu-contrib', contributor({ settle: () => ({ kind: 'ask', reason: '桌上动作要确认', effective: true }) }))
  const r = await m.run(exec('mcp__playwright-mcp__browser_click', { ref: 'p1' }))
  ok(m.cap.fetches === 1, 'CU 闸门同样只发一次请求（fetches=' + m.cap.fetches + '）')
  const qs = Object.keys(m.cap.bodies[0].questions)
  ok(qs.includes('action_kind') && qs.includes('scope_ok'), 'CU 问题与贡献者问题在同一次请求：' + qs.join(','))
  ok(r.kind === 'ask', '贡献者可以把 CU 动作升级为 ask（kind=' + r.kind + '）')
}

out.push('')
out.push('=== 7b. 贡献者结论不进缓存 ===')
{
  const m = mount()
  await m.tools['jev_gate'].execute({ action: 'enforce' }, { agent: { session: { id: 'S1' } } })
  mockJev(m.cap)
  let effective = true
  m.provided.jevGate.contribute('flip', contributor({ settle: () => ({ kind: 'deny', reason: '我先拦', effective }) }))
  const r1 = await m.run(exec('write', { file_path: 'F:/w/flip.ts', content: 'a b c' }))
  ok(r1.kind === 'deny', '贡献者生效时拦下（kind=' + r1.kind + '）')
  effective = false                                    // 贡献者切到"只观察"
  const r2 = await m.run(exec('write', { file_path: 'F:/w/flip.ts', content: 'a b c' }))
  const rec = recs(m.dir).pop()
  ok(rec.path !== 'cache', '模式切换后同形状不再走缓存（path=' + rec.path + '）')
  ok(r2.kind === 'allow', '切换后放行（kind=' + r2.kind + '）')
}

const failed = out.filter((l) => l.startsWith('FAIL'))
console.log(out.join('\n'))
console.log('')
console.log(failed.length === 0 ? '全部通过 (' + out.filter((l) => l.startsWith('PASS')).length + ' 项)' : failed.length + ' 项失败')
process.exitCode = failed.length === 0 ? 0 : 1
