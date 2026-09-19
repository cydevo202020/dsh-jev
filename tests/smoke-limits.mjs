
// 加固与效率的离线冒烟：参数裁剪、形状键上限、有界上下文扫描。
import { apply } from '../lib/index.js'
import { gateState, shapeKeyOf, trimValue } from '../lib/judgment.js'
import { sessionDigest } from '../lib/escalate.js'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TYPESAFE_API_KEY_SMOKE = 'smoke-key'
const out = []
const ok = (c, l) => { out.push((c ? 'PASS ' : 'FAIL ') + l); return c }

function mount(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jev-limits-'))
  const cap = { tools: {}, pre: [], fetches: 0 }
  const ctx = {
    provide: () => {}, effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} }, get: () => undefined,
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
  return { dir, cap, run, tools: cap.tools }
}
const exec = (name, args, sessionId = 'S1') => ({ name, arguments: args, callId: 'c' + Math.random().toString(36).slice(2, 8), signal: AbortSignal.timeout(9000), agent: { session: { id: sessionId } } })
const mockJev = (cap) => {
  globalThis.fetch = async () => {
    cap.fetches++
    return new Response(JSON.stringify({
      model: 'jev-1.13.0',
      answers: { effect: { type: 'choice', choice: 'recoverable', confidence: 0.9, probabilities: {} }, touches_outside_project: { type: 'noul', noul: 0.1 }, needs_human_approval: { type: 'noul', noul: 0.05 } },
      usage: { input_tokens: 100, output_tokens: 0 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}

out.push('=== 1. 参数裁剪 ===')
const big = { file_path: 'F:/w/a.txt', content: 'x'.repeat(50000) }
const trimmed = JSON.stringify(gateState('write', big, 'F:/w', { maxStringChars: 200 }))
ok(trimmed.length < 1000, '5 万字符的写入被裁到 ' + trimmed.length + ' 字符（原来会顶爆 4 万上限）')
ok(trimmed.includes('…'), '被裁的字符串带省略标记')
const raw = JSON.stringify(gateState('write', big, 'F:/w'))
ok(raw.length > 40000, '不传裁剪选项时保持原样（' + raw.length + ' 字符），说明裁剪是显式选项')
ok(JSON.stringify(gateState('write', { file_path: 'F:/w/a.txt' }, 'F:/w', { maxStringChars: 200 })).includes('a.txt'), '小参数不受影响')
ok(JSON.stringify(trimValue({ a: 'secret-value', b: 1 }, { maxStringChars: 50, redactKeys: ['a'] })) === '{"a":"<redacted 12 chars>","b":1}', '脱敏仍然生效')

out.push('')
out.push('=== 2. 形状键上限（太大就不缓存，避免拿截断值撞键）===')
ok(typeof shapeKeyOf('S', 't', { a: 1 }) === 'string', '小参数给出形状键')
ok(shapeKeyOf('S', 't', { a: 'y'.repeat(20000) }) === undefined, '超大参数放弃缓存')

out.push('')
out.push('=== 3. 大参数不再进缓存、也不再撞上 state 上限 ===')
{
  const m = mount()
  await m.tools['jev_gate'].execute({ action: 'enforce' }, { agent: { session: { id: 'S1' } } })
  mockJev(m.cap)
  const args = { file_path: 'F:/w/big.txt', content: 'y'.repeat(30000) }
  const r1 = await m.run(exec('write', { ...args }))
  const r2 = await m.run(exec('write', { ...args }))
  ok(m.cap.fetches === 2, '两次超大参数调用各判一次（fetches=' + m.cap.fetches + '），没有被误当作同一形状')
  ok(r1.kind !== undefined && r2.kind !== undefined, '两次都得到处置（不会因为 state 超限而抛错）')
  const recs = readdirSync(m.dir).filter((f) => f.startsWith('shadow-'))
  const rows = readFileSync(join(m.dir, recs[0]), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  ok(rows.every((x) => x.error === null), '没有一条记录带判定失败（裁剪生效）')
}
{
  const m = mount()
  await m.tools['jev_gate'].execute({ action: 'enforce' }, { agent: { session: { id: 'S1' } } })
  mockJev(m.cap)
  await m.run(exec('write', { file_path: 'F:/w/small.txt' }))
  await m.run(exec('write', { file_path: 'F:/w/small.txt' }))
  ok(m.cap.fetches === 1, '小参数仍然走缓存（fetches=' + m.cap.fetches + '）')
}

out.push('')
out.push('=== 4. 上下文扫描有界 ===')
{
  const events = []
  for (let i = 0; i < 5000; i++) events.push({ type: 'tool/call', data: { name: 'pwsh', arguments: { command: 'echo ' + i } } })
  events.push({ type: 'user/message', data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text: '最新的指令' }] } } })
  let reads = 0
  const session = { seq: events.length, eventAt: (i) => { reads++; return events[i] } }
  const d = sessionDigest(session)
  ok(d.requests.length === 1 && d.requests[0] === '最新的指令', '从 5000 条历史里找到最新指令')
  ok(d.calls.length === 6, '工具调用只取默认的 6 条（实际 ' + d.calls.length + '）')
  ok(reads <= 520, '按需倒扫，最多读 ' + reads + ' 条（上限 500 + 探测）而不是整段历史')

  // 序号语义对不上时退回 snapshotEvents
  const fallbackEvents = [{ type: 'user/message', data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text: '回退路径' }] } } }]
  const weird = { seq: 1, eventAt: () => 'not-an-event', snapshotEvents: () => fallbackEvents }
  const d2 = sessionDigest(weird)
  ok(d2.requests.length === 1 && d2.requests[0] === '回退路径', 'eventAt 形状不对时退回 snapshotEvents')
  ok(sessionDigest({ snapshotEvents: () => { throw new Error('x') } }).requests.length === 0, '两条路都读不到时返回空快照且不抛错')
}

const failed = out.filter((l) => l.startsWith('FAIL'))
console.log(out.join('\n'))
console.log('')
console.log(failed.length === 0 ? '全部通过 (' + out.filter((l) => l.startsWith('PASS')).length + ' 项)' : failed.length + ' 项失败')
process.exitCode = failed.length === 0 ? 0 : 1
