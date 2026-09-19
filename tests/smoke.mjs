/**
 * 离线冒烟测试：不联网，mock global fetch。
 * 覆盖两条通道（工具 / 服务）、三层 key 解析、请求体形状与错误分支。
 */
import { apply } from '../lib/index.js'

const CONFIG = {
  apiKeyEnv: 'TYPESAFE_API_KEY_SMOKE',
  credentialsPath: 'C:/definitely/missing.yaml',
  baseURL: 'https://api.typesafe.ai',
  model: 'jev-latest',
  timeoutMs: 5000,
  maxStateChars: 40000,
  maxRetries: 0,
  gateDefaultMode: 'off',
  gateAskThreshold: 0.5,
  gateDenyThreshold: 2,
  gateTimeoutMs: 5000,
  gateStateFile: 'C:/definitely/missing-dir/state.json',
  gateShadowDir: 'C:/definitely/missing-dir',
  gatePreviewChars: 80,
}

const CANNED = {
  model: 'jev-1.13.0',
  answers: {
    department: { type: 'choice', choice: 'billing', probabilities: { billing: 0.84, technical: 0.159, sales: 0.001 }, confidence: 0.596 },
    frustration: { type: 'score', score: 1.035, legend: { '0': 'Calm', '1': 'Frustrated', '2': 'Very angry' }, probabilities: { '0': 0.05, '1': 0.3, '2': 0.65 }, confidence: 0.842 },
    is_urgent: { type: 'noul', noul: 0.999 },
  },
  usage: { input_tokens: 312, output_tokens: 48 },
}

function mount(credentials) {
  const captured = { provided: null, tool: null }
  const ctx = {
    provide: (name, value) => { if (name === 'jev') captured.provided = { name, value } },
    effect: (fn) => fn(),
    get: (name) => (name === 'credentials' ? credentials : undefined),
    on: () => () => {},
    // 插件现在注册两个工具；这个测试只关心 jev_judge。
    tools: { register: (tool) => { if (tool.name === 'jev_judge') captured.tool = tool; return () => {} } },
  }
  apply(ctx, CONFIG)
  return captured
}

const out = []
const QUESTION = [{ id: 'is_urgent', type: 'noul', instructions: 'Does this convey urgency?' }]

// --- 层 1：credentials 服务优先 -------------------------------------------------
delete process.env.TYPESAFE_API_KEY_SMOKE
let seen = null
globalThis.fetch = async (url, init) => {
  seen = { url, headers: init.headers, body: JSON.parse(init.body) }
  return new Response(JSON.stringify(CANNED), { status: 200, headers: { 'content-type': 'application/json' } })
}
const withStore = mount({ resolve: async (ref) => (ref === 'TYPESAFE_API_KEY_SMOKE' ? { value: 'from-credentials-store' } : undefined) })
out.push('service provided as: ' + withStore.provided.name)
out.push('tool registered as: ' + withStore.tool.name)
out.push('[层1] available() = ' + String(await withStore.provided.value.available()))
const ok = await withStore.tool.execute({
  state: { message: 'I was charged twice, fix it ASAP' },
  questions: [
    { id: 'department', type: 'choice', instructions: 'Which team?', criteria: { billing: 'Payments', technical: 'Bugs' } },
    { id: 'frustration', type: 'score', instructions: 'How frustrated?', criteria: ['Calm', 'Frustrated', 'Very angry'] },
    ...QUESTION,
  ],
})
out.push('[层1] url: ' + seen.url)
out.push('[层1] auth = ' + (seen.headers.authorization === 'Bearer from-credentials-store' ? 'credentials 服务的 key（正确）' : 'WRONG: ' + seen.headers.authorization))
out.push('[层1] questions keys: ' + Object.keys(seen.body.questions).join(','))
out.push('[层1] state 保留为对象: ' + String(typeof seen.body.state === 'object') + '，model: ' + seen.body.model)
out.push('[层1] execute ok=' + String(ok.ok))
out.push(ok.text)

// --- 层 2：服务缺席时回退环境变量 ----------------------------------------------
process.env.TYPESAFE_API_KEY_SMOKE = 'from-env'
const noStore = mount(undefined)
const ok2 = await noStore.tool.execute({ state: 'x', questions: QUESTION })
out.push('')
out.push('[层2] available() = ' + String(await noStore.provided.value.available()))
out.push('[层2] auth = ' + (seen.headers.authorization === 'Bearer from-env' ? '环境变量（正确）' : 'WRONG'))
out.push('[层2] ok=' + String(ok2.ok))

// --- 层 3：三处都没有 -> 可读失败，不是崩溃 -------------------------------------
delete process.env.TYPESAFE_API_KEY_SMOKE
const nothing = mount(undefined)
out.push('')
out.push('[层3] available() = ' + String(await nothing.provided.value.available()))
const denied = await nothing.tool.execute({ state: 'x', questions: QUESTION })
out.push('[层3] ok=' + String(denied.ok) + ' | ' + denied.text)

// --- 服务通道：其它插件不经过 LLM 直接用 ----------------------------------------
const viaService = await withStore.provided.value.ask('x', QUESTION)
out.push('')
out.push('[服务通道] model=' + viaService.model + ' is_urgent.noul=' + String(viaService.answers.is_urgent.noul) + ' department.choice=' + viaService.answers.department.choice)

// --- 401 翻译 ------------------------------------------------------------------
globalThis.fetch = async () => new Response('{"error":"unauthorized"}', { status: 401 })
const bad = await withStore.tool.execute({ state: 'x', questions: QUESTION })
out.push('')
out.push('[401] ok=' + String(bad.ok) + ' | ' + bad.text)

console.log(out.join('\n'))
