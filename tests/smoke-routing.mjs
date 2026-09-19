
// 阶段 1 新增路由的离线冒烟：只读跳过、路径字段、失败降级方向。全部 mock fetch，不联网。
import { apply } from '../lib/index.js'
import { isGateObserveTool, riskClassOf } from '../lib/judgment.js'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TYPESAFE_API_KEY_SMOKE = 'smoke-key'
const out = []
const ok = (cond, label) => { out.push((cond ? 'PASS ' : 'FAIL ') + label); return cond }

function mount(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jev-route-'))
  const cap = { tools: {}, listeners: [], fetches: 0 }
  const ctx = {
    provide: () => {},
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    get: () => undefined,
    tools: { register: (t) => { cap.tools[t.name] = t; return () => {} } },
    on: (name, handler) => { if (name === 'tools/pre-execute') cap.listeners.push(handler); return () => {} },
  }
  const config = {
    apiKeyEnv: 'TYPESAFE_API_KEY_SMOKE',
    credentialsPath: 'C:/definitely/missing.yaml',
    baseURL: 'https://api.typesafe.ai',
    model: 'jev-latest',
    timeoutMs: 5000, maxStateChars: 40000, maxRetries: 0,
    gateDefaultMode: 'off', gateAskThreshold: 0.5, gateDenyThreshold: 2, gateTimeoutMs: 3000,
    gateStateFile: join(dir, 'state.json'), gateShadowDir: dir, gatePreviewChars: 80,
    cuGateDefaultMode: 'shadow', cuGateStateFile: join(dir, 'cu-state.json'),
    ...overrides,
  }
  apply(ctx, config)
  const run = (exec, base = async () => ({ kind: 'allow' })) => {
    const dispatch = (i) => async () => (i < cap.listeners.length ? cap.listeners[i](exec, dispatch(i + 1)) : base())
    return dispatch(0)()
  }
  return { dir, cap, run, tools: cap.tools }
}

const exec = (name, args = {}, sessionId = 'S1', parent = undefined) =>
  ({ name, arguments: args, parent, signal: AbortSignal.timeout(5000), agent: { session: { id: sessionId } } })

const gateAnswers = (over = {}) => ({
  effect: { type: 'choice', choice: 'read_only', confidence: 0.99, probabilities: { read_only: 1 }, ...(over.effect ?? {}) },
  touches_outside_project: { type: 'noul', noul: 0.05 },
  needs_human_approval: { type: 'noul', noul: 0.05, ...(over.needs_human_approval ?? {}) },
})
const mockOk = (cap, answers = gateAnswers()) => {
  globalThis.fetch = async () => { cap.fetches++; return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 100, output_tokens: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } }) }
}
const mockDown = (cap) => { globalThis.fetch = async () => { cap.fetches++; throw new Error('network down') } }
const records = (dir, prefix = '') => {
  const f = readdirSync(dir).filter((x) => x.startsWith(prefix + 'shadow-'))[0]
  return f === undefined ? [] : readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

// ---------- 1. 纯函数：名单与风险分档 ----------
out.push('=== 1. 名单与风险分档 ===')
ok(isGateObserveTool('read') && isGateObserveTool('grep') && isGateObserveTool('cordis_inspect_query'), '只读名单命中 read/grep/cordis_inspect_query')
ok(isGateObserveTool('ask_user_question'), '本身就是"向人提问"的工具不再二次判定')
ok(!isGateObserveTool('write') && !isGateObserveTool('pwsh') && !isGateObserveTool('web_search'), '写入/命令/联网读取不在名单里')
ok(!isGateObserveTool('edge_reaper') && !isGateObserveTool('dev_fix_patch') && !isGateObserveTool('dsh_mrs_kb_index'), '带副作用的同类工具不在名单里（edge_reaper/dev_fix_patch/kb_index）')
ok(isGateObserveTool('read', ['read']) && !isGateObserveTool('grep', ['read']), '自定义名单生效')
ok(riskClassOf('pwsh', { command: 'Remove-Item -Recurse -Force C:/x' }) === 'high', 'Remove-Item 判高风险')
ok(riskClassOf('pwsh', { command: 'rm -rf /tmp/x' }) === 'high', 'rm -rf 判高风险')
ok(riskClassOf('pwsh', { command: 'git reset --hard HEAD~3' }) === 'high', 'git reset --hard 判高风险')
ok(riskClassOf('cua_driver_native__kill_app', { pid: 1 }) === 'high', 'kill_app 判高风险')
ok(riskClassOf('write', { file_path: 'F:/x/notes/archived/a.md' }) === 'high', '归档路径判高风险')
ok(riskClassOf('edit', { file_path: 'F:/x/vendor/foo/src/a.ts' }) === 'high', 'vendor 源码判高风险')
ok(riskClassOf('pwsh', { command: 'echo hi' }) === 'normal', 'echo 判普通')
ok(riskClassOf('write', { file_path: 'F:/x/src/a.ts' }) === 'normal', '普通写入判普通')

// ---------- 2. 只读跳过 ----------
out.push('')
out.push('=== 2. 只读跳过 ===')
{
  const m = mount()
  await m.tools['jev_gate'].execute({ action: 'shadow' }, { agent: { session: { id: 'S1' } } })
  mockOk(m.cap)
  const r1 = await m.run(exec('read', { file_path: 'F:/x/a.ts' }))
  ok(m.cap.fetches === 0, 'read 跳过后 0 次网络请求（fetches=' + m.cap.fetches + '）')
  const r2 = await m.run(exec('grep', { pattern: 'x' }))
  ok(m.cap.fetches === 0, 'grep 跳过后仍是 0 次（fetches=' + m.cap.fetches + '）')
  const r3 = await m.run(exec('pwsh', { command: 'echo hi' }))
  ok(m.cap.fetches === 1, 'pwsh 仍然判（fetches=' + m.cap.fetches + '）')
  ok(r1.kind === 'allow' && r2.kind === 'allow' && r3.kind === 'allow', '三条都放行')
  const recs = records(m.dir)
  const skips = recs.filter((x) => x.path === 'skip-observe')
  ok(skips.length === 2, '记录里出现 2 条 skip-observe（实际 ' + skips.length + '）')
  ok(skips.every((x) => x.args === undefined && x.ms === 0), 'skip 记录不带参数、耗时为 0')
  ok(recs.some((x) => x.path === 'jev' && x.tool === 'pwsh'), '被判的那条 path=jev')
}
{
  const m = mount({ gateObserveSkip: false })
  await m.tools['jev_gate'].execute({ action: 'shadow' }, { agent: { session: { id: 'S1' } } })
  mockOk(m.cap)
  await m.run(exec('read', { file_path: 'F:/x/a.ts' }))
  ok(m.cap.fetches === 1, 'gateObserveSkip=false 时 read 仍被判（fetches=' + m.cap.fetches + '）')
}
{
  const m = mount({ gateObserveTools: ['read'] })
  await m.tools['jev_gate'].execute({ action: 'shadow' }, { agent: { session: { id: 'S1' } } })
  mockOk(m.cap)
  await m.run(exec('grep', { pattern: 'x' }))
  ok(m.cap.fetches === 1, '自定义名单只含 read 时，grep 仍被判（fetches=' + m.cap.fetches + '）')
  await m.run(exec('read', { file_path: 'F:/x/a.ts' }))
  ok(m.cap.fetches === 1, '同一次 mount 里 read 被跳过（fetches=' + m.cap.fetches + '）')
}

// ---------- 3. 判定失败时的降级方向（通用闸门）----------
out.push('')
out.push('=== 3. 判定失败降级（通用闸门，enforce）===')
{
  const m = mount()
  await m.tools['jev_gate'].execute({ action: 'enforce' }, { agent: { session: { id: 'S1' } } })
  mockDown(m.cap)
  const normal = await m.run(exec('pwsh', { command: 'echo hi' }))
  ok(normal.kind === 'allow', '普通命令失败 -> 放行（kind=' + normal.kind + '）')
  const high = await m.run(exec('pwsh', { command: 'Remove-Item -Recurse -Force C:/tmp/x' }))
  ok(high.kind === 'ask', '破坏性命令失败 -> 问人（kind=' + high.kind + '）')
  const recs = records(m.dir)
  const fo = recs.filter((x) => x.path === 'failopen')
  const fc = recs.filter((x) => x.path === 'failclosed')
  ok(fo.length === 1 && fo[0].unprotected === true, 'failopen 记录带 unprotected=true')
  ok(fc.length === 1 && fc[0].unprotected === false, 'failclosed 记录 unprotected=false')
  ok(fo[0].verdict === null && fo[0].error !== null, 'failopen 记录里 verdict=null 且带 error 原因')
}
{
  const m = mount()
  await m.tools['jev_gate'].execute({ action: 'shadow' }, { agent: { session: { id: 'S1' } } })
  mockDown(m.cap)
  const high = await m.run(exec('pwsh', { command: 'Remove-Item -Recurse -Force C:/tmp/x' }))
  ok(high.kind === 'allow', 'shadow 模式下高风险失败也只记录不拦（kind=' + high.kind + '）')
}
{
  const m = mount({ gateFailClosedOnTimeout: false })
  await m.tools['jev_gate'].execute({ action: 'enforce' }, { agent: { session: { id: 'S1' } } })
  mockDown(m.cap)
  const high = await m.run(exec('pwsh', { command: 'Remove-Item -Recurse -Force C:/tmp/x' }))
  ok(high.kind === 'allow', 'gateFailClosedOnTimeout=false 回到旧行为（kind=' + high.kind + '）')
}

// ---------- 4. CU 闸门：观察类跳过 + 高风险失败问人 ----------
out.push('')
out.push('=== 4. CU 闸门 ===')
{
  const m = mount()
  await m.tools['jev_gate'].execute({ action: 'shadow', gate: 'cu' }, { agent: { session: { id: 'S1' } } })
  mockOk(m.cap, {})
  await m.run(exec('cua_driver_native__get_window_state', { pid: 1 }))
  ok(m.cap.fetches === 0, 'CU 观察类跳过（fetches=' + m.cap.fetches + '）')
  const recs = records(m.dir, 'cu-')
  ok(recs.some((x) => x.path === 'skip-observe' && x.gate === 'cu'), 'CU 记录里出现 skip-observe')
}
{
  const m = mount()
  await m.tools['jev_gate'].execute({ action: 'enforce', gate: 'cu' }, { agent: { session: { id: 'S1' } } })
  mockDown(m.cap)
  const high = await m.run(exec('cua_driver_native__kill_app', { pid: 9 }))
  ok(high.kind === 'ask', 'CU 高风险失败 -> 问人（kind=' + high.kind + '）')
  const low = await m.run(exec('mcp__playwright-mcp__browser_click', { ref: 'p1' }))
  ok(low.kind === 'allow', 'CU 普通动作失败 -> 放行（kind=' + low.kind + '）')
}

const failed = out.filter((l) => l.startsWith('FAIL'))
console.log(out.join('\n'))
console.log('')
console.log(failed.length === 0 ? '全部通过 (' + out.filter((l) => l.startsWith('PASS')).length + ' 项)' : failed.length + ' 项失败')
process.exitCode = failed.length === 0 ? 0 : 1
