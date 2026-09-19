// browserVisibility 分类器的离线测试：全部 mock fetch，不联网。
import { apply } from '../lib/index.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TYPESAFE_API_KEY_SMOKE = 'smoke-key'
const dir = mkdtempSync(join(tmpdir(), 'jev-vis-'))
const provided = {}
const ctx = {
  provide: (n, v) => { provided[n] = v },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  get: () => undefined,
  tools: { register: () => () => {} },
  on: () => () => {},
}
apply(ctx, {
  apiKeyEnv: 'TYPESAFE_API_KEY_SMOKE',
  credentialsPath: 'C:/definitely/missing.yaml',
  baseURL: 'https://api.typesafe.ai',
  model: 'jev-latest',
  timeoutMs: 30000, maxStateChars: 40000, maxRetries: 0,
  gateDefaultMode: 'off', gateAskThreshold: 0.5, gateDenyThreshold: 2, gateTimeoutMs: 3000,
  gateStateFile: join(dir, 'state.json'), gateShadowDir: dir, gatePreviewChars: 80,
  cuGateDefaultMode: 'shadow', cuGateStateFile: join(dir, 'cu-state.json'),
  runtimeConfigFile: join(dir, 'config.json'),
})

const out = []
out.push('服务已提供: ' + Object.keys(provided).join(', '))

const session = {
  seq: 4,
  eventAt: (i) => i === 2
    ? { type: 'user/message', data: { message: { content: [{ type: 'text', text: '演示一下这个页面的操作' }] } } }
    : { type: 'turn/start', data: {} },
}
const agent = { session }
const vis = provided.browserVisibility
out.push('visible 是函数: ' + (typeof vis?.visible === 'function'))

let fetches = 0
const answer = (noul) => { globalThis.fetch = async () => { fetches++; return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { visible: { type: 'noul', noul } }, usage: { input_tokens: 80, output_tokens: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } }) } }

answer(0.9)
out.push('[1 判为可见] ' + (await vis.visible({ agent })) + ' fetches=' + fetches)

answer(0.1)
out.push('[2 判为不可见] ' + (await vis.visible({ agent })))

out.push('[3 无会话] ' + (await vis.visible({})))
out.push('[4 会话里没有用户消息] ' + (await vis.visible({ agent: { session: { seq: 1, eventAt: () => ({ type: 'turn/start', data: {} }) } } })))

globalThis.fetch = async () => { throw new Error('network down') }
out.push('[5 Jev 故障] ' + (await vis.visible({ agent })) + '（应为 false）')

// 关掉开关后不发请求
const before = fetches
globalThis.fetch = async () => { fetches++; throw new Error('should not be called') }
const ctx2 = { ...ctx, provide: (n, v) => { provided[n] = v } }
const dir2 = mkdtempSync(join(tmpdir(), 'jev-vis2-'))
apply(ctx2, {
  apiKeyEnv: 'TYPESAFE_API_KEY_SMOKE', credentialsPath: 'C:/nope.yaml', baseURL: 'https://api.typesafe.ai',
  model: 'jev-latest', timeoutMs: 30000, maxStateChars: 40000, maxRetries: 0,
  gateDefaultMode: 'off', gateAskThreshold: 0.5, gateDenyThreshold: 2, gateTimeoutMs: 3000,
  gateStateFile: join(dir2, 's.json'), gateShadowDir: dir2, gatePreviewChars: 80,
  cuGateStateFile: join(dir2, 'cu.json'), runtimeConfigFile: join(dir2, 'c.json'),
  browserVisibilityEnabled: false,
})
const before2 = fetches
out.push('[6 开关关闭] ' + (await provided.browserVisibility.visible({ agent })) + ' 新增请求=' + (fetches - before2))

console.log(out.join('\n'))
