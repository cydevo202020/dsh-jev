
import { apply } from '../lib/index.js'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'jev-iso-'))
const make = (captured) => ({
  provide: () => {}, effect: (fn) => fn(), get: () => undefined, on: () => () => {},
  tools: { register: (t) => { captured.tools[t.name] = t; return () => {} } },
})
const CONFIG = (stateFile, defaultMode) => ({
  apiKeyEnv: 'TYPESAFE_API_KEY_SMOKE', credentialsPath: 'C:/nope.yaml',
  baseURL: 'https://api.typesafe.ai', model: 'jev-latest',
  timeoutMs: 1000, maxStateChars: 1000, maxRetries: 0,
  gateDefaultMode: defaultMode, gateAskThreshold: 0.5, gateDenyThreshold: 2, gateTimeoutMs: 1000,
  gateStateFile: stateFile, gateShadowDir: dir, gatePreviewChars: 50,
})
process.env.TYPESAFE_API_KEY_SMOKE = 'k'

const stateFile = join(dir, 'state.json')
const cap = { tools: {} }
apply(make(cap), CONFIG(stateFile, 'off'))
const gate = cap.tools['jev_gate']
const A = { agent: { session: { id: 'SESSION-A' } } }
const B = { agent: { session: { id: 'SESSION-B' } } }
const NEW = { agent: { session: { id: 'SESSION-BRAND-NEW' } } }

const line = async (label, ctx) => {
  const r = await gate.execute({ action: 'status' }, ctx)
  const m = /本会话有效模式: (\w+)/.exec(r.text)
  console.log(label.padEnd(42) + '-> ' + m[1])
  return m[1]
}
const set = async (action, scope, ctx) => gate.execute(scope === undefined ? { action } : { action, scope }, ctx)

const out = []
console.log('=== 1. 初始状态（谁都没设置过）===')
out.push(await line('会话 A', A)); out.push(await line('会话 B（从未见过）', B))
out.push(await line('全新会话', NEW))

console.log('\n=== 2. 只把 A 打开 shadow ===')
await set('shadow', undefined, A)
out.push(await line('会话 A（刚开）', A))
out.push(await line('会话 B（从未见过）', B))
out.push(await line('全新会话', NEW))

console.log('\n=== 3. 模拟重启（用同一个文件新建插件实例）===')
const cap2 = { tools: {} }
apply(make(cap2), CONFIG(stateFile, 'off'))
const gate2 = cap2.tools['jev_gate']
const line2 = async (label, ctx) => {
  const r = await gate2.execute({ action: 'status' }, ctx)
  const m = /本会话有效模式: (\w+)/.exec(r.text); console.log(label.padEnd(42) + '-> ' + m[1]); return m[1]
}
out.push(await line2('重启后 会话 A', A)); out.push(await line2('重启后 会话 B', B))

console.log('\n=== 4. 把 A 关掉 ===')
await gate2.execute({ action: 'off' }, A)
out.push(await line2('A（已关）', A)); out.push(await line2('B', B))

console.log('\n=== 5. 唯一会外溢的路径：显式 scope="all" ===')
await gate2.execute({ action: 'shadow', scope: 'all' }, A)
out.push(await line2('A', A)); out.push(await line2('B', B)); out.push(await line2('全新会话', NEW))
console.log('   state.json = ' + readFileSync(stateFile, 'utf8').replace(/\s+/g, ' '))
await gate2.execute({ action: 'off', scope: 'all' }, A)
await gate2.execute({ action: 'off' }, A)
out.push(await line2('scope=all 关回 off 后的 B', B))

console.log('\n=== 6. 没有会话 ID 时（理论上取不到）===')
const r = await gate.execute({ action: 'shadow' }, { agent: {} })
console.log('   返回: ' + r.text.split('\n')[0])
console.log('   mode: ' + r.mode)
console.log('   state.json 未被污染: ' + (readFileSync(stateFile, 'utf8').includes('"*"') ? '包含 * （见上一步）' : '不含 *'))

// out[3] = A 开启后自己的模式（应为 shadow），out[4]/out[5] = 其它会话（应仍为 off）
console.log('\n结论：' + (out[3] === 'shadow' && out[4] === 'off' && out[5] === 'off'
  ? 'A 开启不会外溢 ✓'
  : '❌ 有外溢'))
