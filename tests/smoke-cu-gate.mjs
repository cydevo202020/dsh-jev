// CU/BU 闸门 + 端点回退的离线冒烟测试：全部 mock fetch，不联网。
import { apply } from '../lib/index.js'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TYPESAFE_API_KEY_SMOKE = 'smoke-key'
delete process.env.OPENROUTER_API_KEY_SMOKE

const out = []

const cuAnswers = (over = {}) => ({
  action_kind: { type: 'choice', choice: 'observe', confidence: 0.9, probabilities: { observe: 0.9 }, ...(over.action_kind ?? {}) },
  reversibility: { type: 'score', score: 0, confidence: 0.9, ...(over.reversibility ?? {}) },
  touches_credentials: { type: 'noul', noul: 0.05, ...(over.touches_credentials ?? {}) },
  sensitive_surface: { type: 'noul', noul: 0.05, ...(over.sensitive_surface ?? {}) },
  needs_human_approval: { type: 'noul', noul: 0.05, ...(over.needs_human_approval ?? {}) },
})

function mount(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jev-cu-'))
  const cap = { tools: {}, listeners: [], fetchUrls: [], fetchBodies: [] }
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
  return { dir, cap, run, config, tools: cap.tools }
}

/** 固定一个 mock fetch：按 url 决定状态码，默认 200。 */
function mockFetch(cap, options = {}) {
  const { answers = cuAnswers(), statusBy = () => 200 } = options
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    cap.fetchUrls.push(u)
    cap.fetchBodies.push(String(init?.body ?? ''))
    const status = statusBy(u, cap.fetchUrls.length)
    if (status !== 200) return new Response('{"error":{"message":"insufficient balance"}}', { status })
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 100, output_tokens: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}

const exec = (name, args = {}, sessionId = 'S1', parent = undefined) => ({
  name, arguments: args, parent, signal: AbortSignal.timeout(5000), agent: { session: { id: sessionId } },
})

// ---------- 1. 命中与跳过 ----------
{
  const { dir, cap, run } = mount()
  mockFetch(cap)
  const r = await run(exec('cua_driver_native__click', { pid: 42, element_index: 4 }))
  out.push('[1 CU 点击 shadow] decision=' + r.kind + ' fetches=' + cap.fetchUrls.length)
  const files = readdirSync(dir).filter((f) => f.startsWith('cu-shadow-'))
  out.push('[1 影子文件] ' + files.join(', '))
  const rec = JSON.parse(readFileSync(join(dir, files[0]), 'utf8').split('\n').filter(Boolean)[0])
  out.push('[1 记录] gate=' + rec.gate + ' tool=' + rec.tool + ' verdict=' + rec.verdict + ' endpoint=' + rec.endpoint)

  mockFetch(cap)
  cap.fetchUrls.length = 0
  const obs = await run(exec('cua_driver_native__get_window_state', { pid: 42 }))
  out.push('[1 观察类跳过] decision=' + obs.kind + ' fetches=' + cap.fetchUrls.length)

  mockFetch(cap)
  cap.fetchUrls.length = 0
  const other = await run(exec('pwsh', { command: 'echo hi' }))
  out.push('[1 非 CU 工具] decision=' + other.kind + ' fetches=' + cap.fetchUrls.length)

  mockFetch(cap)
  cap.fetchUrls.length = 0
  const bc = await run(exec('browser_code', { script: 'await page.goto("https://x")' }))
  out.push('[1 browser_code 命中] decision=' + bc.kind + ' fetches=' + cap.fetchUrls.length)
}

// ---------- 2. 参数脱敏与截断 ----------
{
  const { cap, run } = mount()
  mockFetch(cap)
  await run(exec('mcp__playwright-mcp__browser_type', { ref: 'p3:12', text: 'hunter2-secret', replace: true }))
  const body = cap.fetchBodies[0] ?? ''
  out.push('[2 脱敏] 含明文=' + body.includes('hunter2-secret') + ' 含占位=' + body.includes('<redacted 14 chars>'))
  const state = JSON.parse(body).state
  out.push('[2 state] surface=' + state.candidate.surface + ' args=' + JSON.stringify(state.candidate.arguments))
}

// ---------- 3. 判决规则 ----------
{
  const { cap, run, tools } = mount()
  await tools['jev_gate'].execute({ action: 'enforce', gate: 'cu' }, { agent: { session: { id: 'S1' } } })

  mockFetch(cap, { answers: cuAnswers({ action_kind: { choice: 'destructive', confidence: 0.95 }, reversibility: { score: 2 } }) })
  const d = await run(exec('cua_driver_native__kill_app', { pid: 42 }))
  out.push('[3 destructive] kind=' + d.kind + ' | ' + String(d.reason).slice(0, 60))

  mockFetch(cap, { answers: cuAnswers({ action_kind: { choice: 'commit', confidence: 0.9 }, touches_credentials: { noul: 0.9 } }) })
  const c = await run(exec('mcp__playwright-mcp__browser_click', { element: 'Sign in' }))
  out.push('[3 commit+凭证] kind=' + c.kind)

  mockFetch(cap, { answers: cuAnswers({ action_kind: { choice: 'input', confidence: 0.9 } }) })
  const i = await run(exec('mcp__playwright-mcp__browser_type', { ref: 'p1', text: 'x' }))
  out.push('[3 input 低风险] kind=' + i.kind)

  mockFetch(cap, { answers: cuAnswers({ action_kind: { choice: 'observe', confidence: 0.9 }, needs_human_approval: { noul: 0.8 } }) })
  const h = await run(exec('cua_driver_native__scroll', {}))
  out.push('[3 needs_human 高] kind=' + h.kind)

  // 失败降级
  globalThis.fetch = async () => { throw new Error('network down') }
  const f = await run(exec('cua_driver_native__click', { pid: 1 }))
  out.push('[3 Jev 故障] kind=' + f.kind + '（降级为 allow）')
}

// ---------- 4. 两个闸门互不干扰 ----------
{
  const { tools, run, cap } = mount()
  await tools['jev_gate'].execute({ action: 'enforce', gate: 'cu' }, { agent: { session: { id: 'S1' } } })
  mockFetch(cap, { answers: cuAnswers({ action_kind: { choice: 'destructive', confidence: 0.95 } }) })
  const cu = await run(exec('cua_driver_native__kill_app', { pid: 7 }))
  cap.fetchUrls.length = 0
  const plain = await run(exec('pwsh', { command: 'rm -rf /' }))
  out.push('[4 独立性] cu=' + cu.kind + ' tools=' + plain.kind + ' tools-fetches=' + cap.fetchUrls.length)
  const st = await tools['jev_gate'].execute({ action: 'status' }, { agent: { session: { id: 'S1' } } })
  out.push('[4 status]\n' + st.text)
}

// ---------- 5. 端点回退 ----------
{
  const { cap, run } = mount({
    endpoints: [
      { label: 'typesafe', baseURL: 'https://api.typesafe.ai', path: '/v1/systemone', apiKeyEnv: 'MISSING_KEY_X' },
      { label: 'openrouter', baseURL: 'https://openrouter.ai/api', path: '/alpha/decisions', apiKeyEnv: 'TYPESAFE_API_KEY_SMOKE' },
    ],
  })
  mockFetch(cap)
  const r = await run(exec('cua_driver_native__click', { pid: 1 }))
  out.push('[5 缺 key 回退] urls=' + JSON.stringify(cap.fetchUrls) + ' decision=' + r.kind)
}
{
  const { cap, run } = mount({
    endpoints: [
      { label: 'typesafe', baseURL: 'https://api.typesafe.ai', path: '/v1/systemone', apiKeyEnv: 'TYPESAFE_API_KEY_SMOKE' },
      { label: 'openrouter', baseURL: 'https://openrouter.ai/api', path: '/alpha/decisions', apiKeyEnv: 'TYPESAFE_API_KEY_SMOKE' },
    ],
  })
  mockFetch(cap, { statusBy: (url) => (url.includes('typesafe.ai') ? 402 : 200) })
  const r = await run(exec('cua_driver_native__click', { pid: 1 }))
  out.push('[5 402 额度耗尽回退] urls=' + JSON.stringify(cap.fetchUrls) + ' decision=' + r.kind)
}
{
  const { cap, run } = mount()
  mockFetch(cap)
  await run(exec('cua_driver_native__click', { pid: 1 }))
  out.push('[5 单端点默认路径] url=' + cap.fetchUrls[0])
}

// ---------- 6. 运行时覆盖文件（注入态下唯一的配置入口）----------
{
  const m = mount()
  const cfgPath = join(m.dir, 'config.json')
  m.config.runtimeConfigFile = cfgPath
  writeFileSync(cfgPath, JSON.stringify({
    endpoints: [{ label: 'from-file', baseURL: 'https://example.invalid/api', path: '/decisions', apiKeyEnv: 'TYPESAFE_API_KEY_SMOKE' }],
  }))
  mockFetch(m.cap)
  await m.run(exec('cua_driver_native__click', { pid: 1 }))
  out.push('[6 覆盖文件首次读取] urls=' + JSON.stringify(m.cap.fetchUrls))

  // 改写文件后不重载也应该立即生效（mtime/size 变化即重新解析）。
  writeFileSync(cfgPath, JSON.stringify({
    endpoints: [{ label: 'hot', baseURL: 'https://hot.example.invalid/api', path: '/x', apiKeyEnv: 'TYPESAFE_API_KEY_SMOKE' }],
    cuGateAskThreshold: 0,
  }))
  m.cap.fetchUrls.length = 0
  mockFetch(m.cap, { answers: cuAnswers({ needs_human_approval: { noul: 0 } }) })
  await m.run(exec('cua_driver_native__click', { pid: 1 }))
  out.push('[6 覆盖文件热生效] urls=' + JSON.stringify(m.cap.fetchUrls))
}

console.log(out.join('\n'))
