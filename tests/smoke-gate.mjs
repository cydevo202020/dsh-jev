
import { apply } from '../lib/index.js'
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'jev-gate-'))
const captured = { tools: {}, listeners: [], provided: null }
const ctx = {
  provide: (n, v) => { captured.provided = { n, v } },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  get: () => undefined,
  tools: { register: (t) => { captured.tools[t.name] = t; return () => {} } },
  on: (name, handler) => { if (name === 'tools/pre-execute') captured.listeners.push(handler); return () => {} },
}

process.env.TYPESAFE_API_KEY_SMOKE = 'smoke-key'
apply(ctx, {
  apiKeyEnv: 'TYPESAFE_API_KEY_SMOKE',
  credentialsPath: 'C:/definitely/missing.yaml',
  baseURL: 'https://api.typesafe.ai',
  model: 'jev-latest',
  timeoutMs: 5000, maxStateChars: 40000, maxRetries: 0,
  gateDefaultMode: 'off', gateAskThreshold: 0.5, gateDenyThreshold: 2, gateTimeoutMs: 3000,
  gateStateFile: join(dir, 'state.json'), gateShadowDir: dir, gatePreviewChars: 80,
})

// 两个闸门各注册一个 pre-execute 监听器；按注册顺序串成一条链，忠实还原 waterfall。
const runListeners = (exec, base) => {
  const dispatch = (i) => async () => (i < captured.listeners.length ? captured.listeners[i](exec, dispatch(i + 1)) : base())
  return dispatch(0)()
}

const out = []
out.push('tools: ' + Object.keys(captured.tools).join(', '))
out.push('service: ' + captured.provided.n + ' | listeners installed: ' + captured.listeners.length)

const S = { id: 'S1' }
const exec = (name, parent) => ({ name, arguments: { command: 'echo hi' }, parent, signal: AbortSignal.timeout(5000), agent: { session: S } })
const next = async () => ({ kind: 'allow' })

let fetches = 0
const setResponse = (answers) => { globalThis.fetch = async () => { fetches++; return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 200, output_tokens: 0 } }), { status: 200, headers: {'content-type':'application/json'} }) } }

// A) 默认 off：不判、不联网
fetches = 0
let r = await runListeners(exec('pwsh'), next)
out.push('[A off] decision=' + r.kind + ' fetches=' + fetches)

// B) 打开 shadow
const on = await captured.tools['jev_gate'].execute({ action: 'shadow' }, { agent: { session: S } })
out.push('[B shadow] ' + on.text.split('\n')[0])

setResponse({
  effect: { type: 'choice', choice: 'recoverable', confidence: 0.93, probabilities: { recoverable: 0.95 } },
  touches_outside_project: { type: 'noul', noul: 0.9 },
  needs_human_approval: { type: 'noul', noul: 0.7 },
})
fetches = 0
r = await runListeners(exec('pwsh'), next)
out.push('[B shadow] decision=' + r.kind + '（仍然放行） fetches=' + fetches)

// C) 顶层 run_code 跳过
fetches = 0
r = await runListeners(exec('run_code', undefined), next)
out.push('[C 顶层run_code] decision=' + r.kind + ' fetches=' + fetches)
// C2) 嵌套 run_code 子调用不跳过
fetches = 0
r = await runListeners(exec('run_code', { ptc: true }), next)
out.push('[C2 嵌套run_code] decision=' + r.kind + ' fetches=' + fetches)

// D) 控制工具自身豁免
fetches = 0
r = await runListeners(exec('jev_gate', undefined), next)
out.push('[D jev_gate 自身] decision=' + r.kind + ' fetches=' + fetches)

// E) enforce：同一条高 needs_human -> ask
await captured.tools['jev_gate'].execute({ action: 'enforce' }, { agent: { session: S } })
r = await runListeners(exec('pwsh'), next)
out.push('[E enforce ask] kind=' + r.kind + ' reason=' + String(r.reason).slice(0, 70))

// F) enforce：低分 -> 放行
setResponse({
  effect: { type: 'choice', choice: 'read_only', confidence: 0.99, probabilities: { read_only: 1 } },
  touches_outside_project: { type: 'noul', noul: 0.05 },
  needs_human_approval: { type: 'noul', noul: 0.05 },
})
r = await runListeners(exec('pwsh'), next)
out.push('[F enforce pass] kind=' + r.kind)

// G) Jev 挂了 -> 放行走既有权限链
globalThis.fetch = async () => { throw new Error('network down') }
r = await runListeners(exec('pwsh'), next)
out.push('[G Jev 故障] kind=' + r.kind + '（降级）')

// H) 会话隔离：另一个会话仍是 off
r = await runListeners({ ...exec('pwsh'), agent: { session: { id: 'S2' } } }, next)
out.push('[H 会话隔离] S2 kind=' + r.kind + '（应为 allow，因为 S2 是 off）')

// I) 落盘检查
const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
out.push('[I state.json] ' + JSON.stringify(st))
const files = readdirSync(dir).filter(f => f.startsWith('shadow-'))
out.push('[I shadow files] ' + files.join(', '))
const lines = readFileSync(join(dir, files[0]), 'utf8').split('\n').filter(Boolean)
out.push('[I shadow 条数] ' + lines.length)
out.push('[I 首条] ' + lines[0].slice(0, 260))
out.push('[I 最后一条] ' + lines[lines.length - 1].slice(0, 200))

// J) status
const st2 = await captured.tools['jev_gate'].execute({ action: 'status' }, { agent: { session: S } })
out.push('[J status]')
out.push(st2.text)

console.log(out.join('\n'))
