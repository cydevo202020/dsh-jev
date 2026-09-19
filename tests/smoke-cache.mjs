
// 阶段 2 的离线冒烟：形状缓存、人工批准记忆、端点预算公平分配、超时缩放。全部 mock fetch。
import { apply } from '../lib/index.js'
import { scaledTimeoutMs, shapeKeyOf, stableJson } from '../lib/judgment.js'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TYPESAFE_API_KEY_SMOKE = 'smoke-key'
const out = []
const ok = (cond, label) => { out.push((cond ? 'PASS ' : 'FAIL ') + label); return cond }
// 看门狗：任何一步卡住都别让进程悬着，直接把已有的结论打出来。
const wd = setTimeout(() => { console.log(out.join('\n')); console.log('WATCHDOG: 25 秒未结束'); process.exit(3) }, 25_000)

function mount(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jev-cache-'))
  const cap = { tools: {}, pre: [], post: [], fetches: 0, urls: [] }
  const ctx = {
    provide: () => {},
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    get: () => undefined,
    tools: { register: (t) => { cap.tools[t.name] = t; return () => {} } },
    on: (name, handler) => {
      if (name === 'tools/pre-execute') cap.pre.push(handler)
      if (name === 'tools/post-execute') cap.post.push(handler)
      return () => {}
    },
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
    const dispatch = (i) => async () => (i < cap.pre.length ? cap.pre[i](exec, dispatch(i + 1)) : base())
    return dispatch(0)()
  }
  const post = (exec, result) => {
    const dispatch = (i) => async () => (i < cap.post.length ? cap.post[i](exec, result, dispatch(i + 1)) : undefined)
    return dispatch(0)()
  }
  return { dir, cap, run, post, tools: cap.tools }
}

let callSeq = 0
const exec = (name, args = {}, sessionId = 'S1', parent = undefined) =>
  ({ name, arguments: args, parent, callId: 'c' + (++callSeq), signal: AbortSignal.timeout(5000), agent: { session: { id: sessionId } } })

const answers = (noul = 0.05) => ({
  effect: { type: 'choice', choice: 'read_only', confidence: 0.99, probabilities: { read_only: 1 } },
  touches_outside_project: { type: 'noul', noul: 0.05 },
  needs_human_approval: { type: 'noul', noul },
})
const mockOk = (cap, a = answers()) => {
  globalThis.fetch = async (url) => { cap.fetches++; cap.urls.push(String(url)); return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: a, usage: { input_tokens: 100, output_tokens: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } }) }
}
const recs = (dir) => {
  const f = readdirSync(dir).filter((x) => x.startsWith('shadow-'))[0]
  return f === undefined ? [] : readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

// ---------- 1. 纯函数 ----------
out.push('=== 1. 形状键与超时缩放 ===')
ok(shapeKeyOf('S', 't', { a: 1, b: 2 }) === shapeKeyOf('S', 't', { b: 2, a: 1 }), '键序不同但形状相同')
ok(shapeKeyOf('S', 't', { a: 1 }) !== shapeKeyOf('S2', 't', { a: 1 }), '不同会话形状不同')
ok(shapeKeyOf('S', 't', { a: 1 }) !== shapeKeyOf('S', 't', { a: 2 }), '参数不同形状不同')
ok(stableJson({ b: [1, { d: 1, c: 2 }], a: 0 }) === '{"a":0,"b":[1,{"c":2,"d":1}]}', 'stableJson 递归排序：' + stableJson({ b: [1, { d: 1, c: 2 }], a: 0 }))
ok(scaledTimeoutMs(8000, 500) === 8000, '小 state 不放大')
ok(scaledTimeoutMs(8000, 4000) === 8500, '4k state 放大 500ms（实际 ' + scaledTimeoutMs(8000, 4000) + '）')
ok(scaledTimeoutMs(4000, 100000) === 8000, '放大上限是基准两倍')

// ---------- 2. 形状缓存 ----------
out.push('')
out.push('=== 2. 形状缓存 ===')
{
  const m = mount()
  await m.tools['jev_gate'].execute({ action: 'enforce' }, { agent: { session: { id: 'S1' } } })
  mockOk(m.cap)
  const a1 = await m.run(exec('pwsh', { command: 'echo same' }))
  const a2 = await m.run(exec('pwsh', { command: 'echo same' }))
  const a3 = await m.run(exec('pwsh', { command: 'echo other' }))
  ok(m.cap.fetches === 2, '同样参数第二次不再请求（fetches=' + m.cap.fetches + '，期望 2）')
  ok(a1.kind === 'allow' && a2.kind === 'allow' && a3.kind === 'allow', '三条都放行')
  const r = recs(m.dir)
  ok(r.filter((x) => x.path === 'cache').length === 1, '记录里出现 1 条 path=cache')
  const c = r.filter((x) => x.path === 'cache')[0]
  ok(c !== undefined && c.ms === 0 && c.verdict === 'pass', 'cache 记录 ms=0、verdict=pass')

  // 缓存里的 ask 在 enforce 下仍然会拦
  mockOk(m.cap, answers(0.9))
  const b1 = await m.run(exec('write', { file_path: 'F:/x/a.txt' }))
  const b2 = await m.run(exec('write', { file_path: 'F:/x/a.txt' }))
  ok(b1.kind === 'ask' && b2.kind === 'ask', 'ask 结论被缓存后仍然拦（b2=' + b2.kind + '）')
  // shadow 下缓存不得改变"只记录不拦"
  await m.tools['jev_gate'].execute({ action: 'shadow' }, { agent: { session: { id: 'S1' } } })
  const b3 = await m.run(exec('write', { file_path: 'F:/x/a.txt' }))
  ok(b3.kind === 'allow', 'shadow 模式下缓存命中也不拦（kind=' + b3.kind + '）')
}
{
  const m = mount({ gateCacheTtlMs: 0 })
  await m.tools['jev_gate'].execute({ action: 'enforce' }, { agent: { session: { id: 'S1' } } })
  mockOk(m.cap)
  await m.run(exec('pwsh', { command: 'echo same' }))
  await m.run(exec('pwsh', { command: 'echo same' }))
  ok(m.cap.fetches === 2, 'gateCacheTtlMs=0 时每次都判（fetches=' + m.cap.fetches + '）')
}

// ---------- 3. 人工批准过的形状 ----------
out.push('')
out.push('=== 3. 批准记忆（默认关闭，显式打开才生效）===')
{
  const m = mount({ gateCacheTtlMs: 0, gateApproveOnceTtlMs: 60000 })
  await m.tools['jev_gate'].execute({ action: 'enforce' }, { agent: { session: { id: 'S1' } } })
  mockOk(m.cap, answers(0.9))
  const e1 = exec('edit', { file_path: 'F:/x/b.ts' })
  const a1 = await m.run(e1)
  ok(a1.kind === 'ask', '第一次高风险动作 -> 问人')
  await m.post(e1, { isError: false })
  const a2 = await m.run(exec('edit', { file_path: 'F:/x/b.ts' }))
  ok(a2.kind === 'allow', '批准过的形状第二次直接放行（kind=' + a2.kind + '）')
  ok(recs(m.dir).some((x) => x.path === 'shape-approved'), '记录里出现 path=shape-approved')

  // 失败的结果不算批准
  const e3 = exec('edit', { file_path: 'F:/x/c.ts' })
  const a3 = await m.run(e3)
  ok(a3.kind === 'ask', '新形状仍然问人')
  await m.post(e3, { isError: true })
  const a4 = await m.run(exec('edit', { file_path: 'F:/x/c.ts' }))
  ok(a4.kind === 'ask', '执行失败（isError）不算批准，仍然问人（kind=' + a4.kind + '）')

  // 没经过闸门 if 的调用不会污染记忆
  await m.post({ callId: 'never-seen' }, { isError: false })
  ok(true, '未知 callId 的 post-execute 不报错')
}
{
  const m = mount({ gateCacheTtlMs: 0, gateApproveOnceTtlMs: 0 })
  await m.tools['jev_gate'].execute({ action: 'enforce' }, { agent: { session: { id: 'S1' } } })
  mockOk(m.cap, answers(0.9))
  const e1 = exec('edit', { file_path: 'F:/x/d.ts' })
  await m.run(e1)
  await m.post(e1, { isError: false })
  const a2 = await m.run(exec('edit', { file_path: 'F:/x/d.ts' }))
  ok(a2.kind === 'ask', 'gateApproveOnceTtlMs=0（默认）时不记忆，仍然问人')
}

// ---------- 4. 端点预算公平分配 ----------
out.push('')
out.push('=== 4. 端点预算 ===')
{
  const m = mount({
    gateTimeoutMs: 1200,
    endpoints: [
      { label: 'typesafe', baseURL: 'https://api.typesafe.ai', path: '/v1/systemone', apiKeyEnv: 'TYPESAFE_API_KEY_SMOKE' },
      { label: 'openrouter', baseURL: 'https://openrouter.ai/api', path: '/alpha/decisions', apiKeyEnv: 'TYPESAFE_API_KEY_SMOKE' },
    ],
  })
  await m.tools['jev_gate'].execute({ action: 'shadow' }, { agent: { session: { id: 'S1' } } })
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    const u = String(url)
    m.cap.fetches++; m.cap.urls.push(u)
    if (u.includes('typesafe.ai')) {
      // 模拟"第一个端点一直不返回"：只有被中止时才结束。
      const s = init?.signal
      if (s === undefined) return
      if (s.aborted) { reject(new Error('aborted')); return }
      s.addEventListener('abort', () => reject(new Error('aborted')))
      return
    }
    resolve(new Response(JSON.stringify({ model: 'jev-1.13.0', answers: answers(), usage: { input_tokens: 10, output_tokens: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } }))
  })
  const t0 = Date.now()
  const r = await m.run(exec('pwsh', { command: 'echo budget' }))
  const dt = Date.now() - t0
  ok(r.kind === 'allow', '第一个端点卡死时整条链路仍然成功（kind=' + r.kind + '）')
  ok(m.cap.urls.length === 2 && m.cap.urls[1].includes('openrouter'), '备选端点真的被尝试了：' + JSON.stringify(m.cap.urls))
  ok(dt < 3000, '总耗时仍在预算内（' + dt + 'ms）')
}

clearTimeout(wd)
const failed = out.filter((l) => l.startsWith('FAIL'))
console.log(out.join('\n'))
console.log('')
console.log(failed.length === 0 ? '全部通过 (' + out.filter((l) => l.startsWith('PASS')).length + ' 项)' : failed.length + ' 项失败')
process.exitCode = failed.length === 0 ? 0 : 1
