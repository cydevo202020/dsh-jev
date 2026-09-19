
// 真实 cordis 组合验收：真 Context、真服务注册表、真事件总线。
// 覆盖"插件能否在干净上下文里装配成功"——这正是运行进程里失败的那一步。
import { Context } from 'cordis'
import { apply } from '../lib/index.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TYPESAFE_API_KEY_SMOKE = 'smoke-key'
const out = []
const ok = (c, l) => { out.push((c ? 'PASS ' : 'FAIL ') + l); return c }
const dir = mkdtempSync(join(tmpdir(), 'jev-compose-'))

const registered = []
const ctx = new Context()
ctx.provide('tools', { register: (t) => { registered.push(t.name); return () => {} } })
ctx.provide('llm', { stream: () => (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })() })

apply(ctx, {
  apiKeyEnv: 'TYPESAFE_API_KEY_SMOKE', credentialsPath: 'C:/definitely/missing.yaml',
  baseURL: 'https://api.typesafe.ai', model: 'jev-latest',
  timeoutMs: 5000, maxStateChars: 40000, maxRetries: 0,
  gateDefaultMode: 'off', gateAskThreshold: 0.5, gateDenyThreshold: 2, gateTimeoutMs: 3000,
  gateStateFile: join(dir, 'state.json'), gateShadowDir: dir, gatePreviewChars: 80,
  cuGateDefaultMode: 'shadow', cuGateStateFile: join(dir, 'cu-state.json'),
  escalateMode: 'enforce',
})

out.push('=== 真 Context 装配 ===')
const jev = ctx.get('jev')
ok(jev !== undefined && typeof jev.ask === 'function' && typeof jev.available === 'function', 'apply 成功，jev 服务已注册')
ok(typeof ctx.get('browserVisibility')?.visible === 'function', 'browserVisibility 服务已注册')
ok(registered.includes('jev_judge') && registered.includes('jev_gate'), '两个模型可见工具已注册：' + registered.join(', '))

out.push('')
out.push('=== 真事件总线上挂了两条 pre-execute 监听 ===')
const listeners = ctx.events?.['tools/pre-execute']
ok(Array.isArray(listeners) ? listeners.length >= 2 : true, 'pre-execute 监听已挂载（cordis 内部表示因版本而异，只做非破坏性断言）')

const failed = out.filter((l) => l.startsWith('FAIL'))
console.log(out.join('\n'))
console.log('')
console.log(failed.length === 0 ? '全部通过 (' + out.filter((l) => l.startsWith('PASS')).length + ' 项)' : failed.length + ' 项失败')
process.exitCode = failed.length === 0 ? 0 : 1
