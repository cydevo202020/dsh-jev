# @dsh-external/dsh-jev

把 [TypeSafe Jev](https://docs.typesafe.ai/introduction)（System One 决策模型）接进 DeepSeek Harness。

Jev **不是聊天模型**：它不生成文本、没有 messages / tools / streaming。它只接受一个
state 加一组带类型的问题（choice / score / noul），返回结构化答案、概率分布和置信度。
因此它替代的不是主 agent 循环，而是那些**本该问 LLM 的窄判定**。

本插件提供三条通道：

| 通道 | 形态 | 谁来调用 | 典型用途 |
| --- | --- | --- | --- |
| 工具 jev_judge | 模型可见工具 | 主 agent（ds） | 把分类 / 路由 / 打分 / 是否外包出去，省 token、省往返 |
| 服务 jev | ctx 服务 | 其它插件或 host 代码 | await ctx.get('jev').ask(state, questions)，全程不经过 LLM |
| 工具闸门 ×2 | tools/pre-execute 监听 | 代码自动跑 | 每次工具调用前判一次；分 `tools`（shell/文件/网络）与 `cu`（computer-use/browser-use）两个独立闸门，按会话开关，可只记录不上岗 |

只有走**服务**通道或**闸门**才真正"代替 ds"；走工具通道仍然是 ds 在做决定。

## 为什么不能把它做成一个 LLM provider

DSH 的模型路由只认三种 wire protocol（openai-completions / openai-responses /
anthropic-messages），且 LlmAdapter 的硬契约是
stream(GenerateOptions): AsyncIterable<StreamChunk> —— messages / tools / 流式 delta。
Jev 是一次性判定 API，套进这个契约要写一个丢弃 messages、把答案伪装成 assistant 文本的
退化 adapter，会同时丢掉 token 计量、上下文窗口和工具调用语义。所以正解是插件：
工具给 agent 用，服务给代码用。

## 安装

    # 1. 构建（需要 bash + node）
    DSH_CHECKOUT=<dsh checkout> bash scripts/build.sh

    # 2. 注入（免重启）
    dev_inject_plugin  dir = <本目录>        # 临时，重启失效
    dev_install_package dir = <本目录>       # 持久装配进 profile

API key 按 DSH 的分层顺序解析，三处按序命中即可：

1. **ctx.credentials 服务** —— 环境变量、.env、托管凭证库（推荐；与 llm、web 等包同一套）
2. **本进程环境变量** —— 注意必须在 dsh 启动**之前**设置，运行中改不掉
3. **~/.dsh/.credentials.yaml 的 refs: 段** —— 每次调用重新读盘，**运行中的进程靠它热生效**

    refs:
      TYPESAFE_API_KEY: ts_live_xxx

## 配置项

**两条装配路径的配置入口不同**，先确认自己在哪条：

- **profile bundle 装配**（profile `package.json` 的 `dsh.profile.bundles` → 包自带 `cordis.patch.yml`）：用下面的 cordis 配置。
- **super-injector 运行时注入**：注入器用 `loader.create({ name, config: {} })` 建 entry，**entry 配置恒为空**，cordis.yml 里写多少都到不了插件。这条路必须用下面的运行时覆盖文件。

### 注入态：运行时覆盖文件（热生效）

默认路径 `~/.dsh/jev-gate/config.json`。顶层键**浅合并**到插件配置上，每次判定前重读（按 mtime+size 缓存），所以改完不用热重载、不用重启；从文件里删掉某个键即退回基准值。

    {
      "endpoints": [
        { "label": "typesafe", "baseURL": "https://api.typesafe.ai", "path": "/v1/systemone",
          "apiKeyEnv": "TYPESAFE_API_KEY", "model": "jev-latest" },
        { "label": "openrouter", "baseURL": "https://openrouter.ai/api", "path": "/alpha/decisions",
          "apiKeyEnv": "OPENROUTER_API_KEY", "model": "typesafe/jev-1.13" }
      ],
      "cuGateDefaultMode": "shadow",
      "cuGateAskThreshold": 0.5
    }

把 `runtimeConfigFile` 设为空串即可完全关闭覆盖。

### bundle 态：cordis 配置

    - insert:
        - id: dsh-jev
          name: '@dsh-external/dsh-jev'
          config:
            apiKeyEnv: TYPESAFE_API_KEY
            model: jev-latest
            timeoutMs: 30000
            maxStateChars: 40000
            maxRetries: 2
            runtimeConfigFile: ~/.dsh/jev-gate/config.json
            # 通用工具闸门（shell / 文件 / 网络）
            gateDefaultMode: off        # off | shadow | enforce
            gateAskThreshold: 0.5       # needs_human_approval 超过它就升级给人
            gateDenyThreshold: 2        # 默认 2 = 永不自动 deny
            gateTimeoutMs: 8000         # 链路总预算；按剩余端点均分，随 state 体积最多放大 2 倍
            gateObserveSkip: true       # 只读/自省工具直接跳过判定（回溯实测省掉 46.8% 的调用）
            gateFailClosedOnTimeout: true # 判定失败：高风险改问人，其余才交回既有权限链
            gateArgChars: 2000          # 单个字符串参数的截断长度
            gateCacheTtlMs: 60000       # 同会话同形状复用窗口；0 关闭
            gateApproveOnceTtlMs: 0     # 人工批准过的形状免问窗口；0 关闭（默认关）
            # 放权：判定器拿不准时交给带完整上下文的 LLM 分类器
            escalateMode: shadow        # off | shadow（只记录）| enforce（接管处置）
            escalateTimeoutMs: 8000
            escalateMaxPerSession: 40   # 单会话放权上限
            gateStateFile: ~/.dsh/jev-gate/state.json
            gateShadowDir: ~/.dsh/jev-gate
            gatePreviewChars: 300       # 影子记录里参数预览的截断长度
            # computer-use / browser-use 专用闸门
            cuGateEnabled: true
            cuGateDefaultMode: shadow   # 默认 shadow：先判、只记录、不拦截
            cuGateAskThreshold: 0.5
            cuGateDenyThreshold: 2      # 默认 2 = 永不自动 deny
            cuGateTimeoutMs: 8000
            cuGateStateFile: ~/.dsh/jev-gate/cu-state.json
            cuToolPrefixes:             # 命中即归 CU 闸门管
              - cua_driver_native__
              - mcp__cua-driver-mcp__
              - mcp__playwright-mcp__
              - browser_code
            cuObserveLeaves: []         # 留空数组 = 用内置只读名单；给了则整体覆盖
            cuRedactKeys: [text, value, prompt_text]   # 这些键的值替换成占位符后才送给 Jev
            cuArgChars: 600             # 单个字符串参数的截断长度
            endpoints:                  # 留空则只用 apiKeyEnv/baseURL/model 描述的官方端点
              - label: typesafe
                baseURL: https://api.typesafe.ai
                path: /v1/systemone
                apiKeyEnv: TYPESAFE_API_KEY
                model: jev-latest
              - label: openrouter
                baseURL: https://openrouter.ai/api
                path: /alpha/decisions
                apiKeyEnv: OPENROUTER_API_KEY
                model: typesafe/jev-1.13

## 工具用法

    {
      "state": { "message": "I was charged twice for order A-104, fix it ASAP" },
      "questions": [
        { "id": "department", "type": "choice", "instructions": "Which team should handle this?",
          "criteria": { "billing": "Payments, refunds", "technical": "Bugs, integrations", "sales": "Pricing" } },
        { "id": "frustration", "type": "score", "instructions": "How frustrated is the customer?",
          "criteria": ["Calm", "Frustrated", "Very angry"] },
        { "id": "is_urgent", "type": "noul", "instructions": "Does this convey urgency?" }
      ]
    }

一次调用里放多个问题几乎不额外增加时延：它们对同一个 state 并行、独立求值。

## 服务用法（插件作者）

    export const inject = ['tools']   // 不要在 inject 里写 'jev'，除非你确实硬依赖它

    export function apply(ctx) {
      ctx.on('tools/pre-execute', async (exec, next) => {
        const jev = ctx.get('jev')              // 可选依赖用 ctx.get，别用 ctx.jev
        if (jev === undefined || !(await jev.available())) return next()

        const result = await jev.ask([exec.name, exec.args], [
          { id: 'risk', type: 'score', instructions: 'How destructive is this tool call?',
            criteria: ['read-only', 'recoverable', 'destructive'] },
        ])
        const answer = result.answers.risk
        if (answer.type === 'score' && answer.score > 1.5 && answer.confidence > 0.7) {
          return { kind: 'deny', reason: 'jev: destructive tool call' }
        }
        return next()
      })
    }

### 把判定挂进同一次调用（`jevGate` 服务）

两个插件各挂一个 `tools/pre-execute` 监听时，一次**通过**的工具调用要付两次网络往返。
`ctx.get('jevGate')` 让其它插件把自己的问题挂进闸门的那一次调用：输入只算一次，
多选题并行求值所以不额外增加时延。

    const gate = ctx.get('jevGate')   // 可选依赖：用 ctx.get，别写 ctx.jevGate
    if (gate !== undefined) {
      gate.contribute('my-rules', (input) => ({
        questions: [{ id: 'in_scope', type: 'noul', instructions: '...', criteria: { true: '...', false: '...' } }],
        state: { my_brief: '...' },                  // 并进同一次调用的 state
        settle(answers, failure) {                   // 拿到答案后得出自己的处置
          if (failure !== undefined) return undefined
          const score = answers.in_scope?.noul ?? 0
          return { kind: score >= 0.9 ? 'deny' : 'pass', reason: 'in_scope=' + score, effective: true }
        },
      }))
    }

- `effective: true` 表示按你自己的模式应当生效；`false` 表示你只在影子模式观察（闸门仍记录，但不改变处置）。
- 合并口径是**最严的赢**：`deny > ask > pass`。
- 贡献者的工厂或结算函数抛错只丢它自己，闸门继续。
- 闸门本会话模式为 `off` 时，只要有贡献者参与，闸门仍然会把问题问出去——否则贡献者等于失效。
- 影子记录里多一个 `contrib` 字段，列出每个贡献者的结论与是否生效。

## computer-use / browser-use 专用闸门

官方 CU（Cua Driver，工具名 `cua_driver_native__*`）与 BU（Playwright MCP，工具名
`mcp__playwright-mcp__browser_*`）的动作同样走 `tools/pre-execute`，所以同一套闸门能判它们。
但通用闸门的问题集是文件口径（"是否越出工作目录"），判桌面动作没有意义，因此单开一个 `cu` 闸门，
问五个桌面/浏览器维度的问题：

| 问题 | 类型 | 它判什么 |
| --- | --- | --- |
| action_kind | choice | observe / input / commit / destructive —— 这一下到底做了什么 |
| reversibility | score | 撤回难度：0 完全可逆 / 1 需费力恢复 / 2 不可逆 |
| touches_credentials | noul | 是否碰密码、验证码、卡号等机密 |
| sensitive_surface | noul | 是否碰资金、隐私、私人通信、管理或安全设置 |
| needs_human_approval | noul | 整体判断：是否该先问人 |

处置规则（`cuVerdictOf`）：`needs_human_approval` 过阈值即 ask；此外叠两条确定性规则 ——
判成 `destructive` 一律 ask；判成 `commit` 且不可逆、或碰到凭证/敏感面也 ask。
默认从不自动 deny（`cuGateDenyThreshold: 2`）。

三层降噪，避免给每一步都白加一次往返：

- **只读跳过**：快照、截图、读窗口树、列窗口、读网络请求等（内置名单见 `CU_OBSERVE_LEAVES`）
  不判定，直接放行。这是延迟与拦截价值的权衡开关。
- **参数脱敏**：`text` / `value` / `prompt_text` 的值替换成 `<redacted N chars>` 再送出，
  密码与卡号不出本机；其余长字符串按 `cuArgChars` 截断。
- **保守默认**：`cuGateDefaultMode` 默认 `shadow` —— 先判、只记录、不拦截，攒够数据再上 enforce。

开关（`gate: "cu"`，与通用闸门完全独立、各存各的模式表）：

    jev_gate({ action: "status",  gate: "cu" })                # 看 cu 闸门模式、状态文件与记录目录
    jev_gate({ action: "shadow",  gate: "cu" })                # 本会话影子模式
    jev_gate({ action: "enforce", gate: "cu" })                # 本会话真的开始拦
    jev_gate({ action: "off",     gate: "cu" })                # 本会话关掉
    jev_gate({ action: "enforce", gate: "cu", scope: "all" })  # 所有未显式设置的会话

影子记录落在同一目录的 `cu-shadow-YYYY-MM-DD.jsonl`，每条含工具名、参数预览、五个维度的判定、
耗时、实际作答端点（`endpoint`）以及"如果真拦会怎样"。

**限制**：闸门只看到工具名与参数，看不到屏幕。`mcp__playwright-mcp__browser_click` 的元素语义
来自 Playwright 传的 `element` 字段（如 "Sign in"），而 Cua 的 `element_index` 本身没有语义 ——
两类工具的判定精度不同。判"这一下是否由页面内容注入诱导"需要会话上下文，当前 state 刻意不含
会话历史（大 state 掉精度），属后续项。

## 与人工审批的关系

闸门判成 `ask` 时**不自己弹窗**：结果交回 `tools/pre-execute`，由 harness 走标准的 `ctx.approval.request` → `approval/request` waterfall。所以人工审批链路完全照旧：

1. `@dsh-external/dsh-approval-bridge`（监听 `approval/request`）在本机原生审批 GUI（`dsh-approval-gui.exe`，命名管道 `\\.\pipe\dsh-approval`）连着时，把请求转给那扇窗；
2. GUI 没连上就 `next()`，落到 WebUI 的审批卡（`@deepseek-ai/dsh-client-ui-approval`）；
3. 两者都不可用（headless 且无 GUI）时结果是 `unavailable` —— **失败关闭**，动作被拒而不是放行。

用 `approval_bridge_status` 看 GUI 是否连着（`clientConnected`）。开 enforce 之前先确认至少有一个 answerer 在线，否则 Jev 判成 `ask` 的调用会直接失败而不是等人点。

## 端点与回退

`baseURL` + `apiKeyEnv` + `model` 描述单个官方端点，行为与旧版一致。要配回退就写 `endpoints`，
按顺序尝试，任一成功即返回：

- **缺 key 的端点直接跳过** —— 所以只配了 OpenRouter key 时自动走备选。
- **HTTP 失败或网络失败就换下一个端点** —— 官方月度余额耗尽（402/403）、限流（429）、
  超时都不会让判定整体失败。
- 全部失败才抛错，错误里带每个端点的失败原因；影子记录与 `jev_gate status` 都会报实际作答的端点标签。

TypeSafe 官方是 `POST {baseURL}/v1/systemone`；OpenRouter 的 alpha Decisions 路由是
`POST https://openrouter.ai/api/alpha/decisions`。两者**请求/响应 schema 一致**
（`{state, model, questions}` → `{model, answers, usage}`），只是路径不同，所以 `path` 必须显式给。

实测（把 OpenRouter 单独置顶后调用一次）：返回 `endpoint: openrouter`、`model: typesafe/jev-1.13-20260917`，
`usage` 里额外带 `cost`；换回官方优先后为 `endpoint: typesafe`、`model: jev-1.13.0`。
所以备选端点是真能作答，不只是"配了不报错"。

两点注意：OpenRouter 那条是 **alpha** 路由，且不在它公开的 `/api/v1/models` 列表里（别用模型列表做能力探测）；
其模型页标 32k 上下文（官方 Jev 1.13 是 64k）。

## 工具闸门（按会话热插拔）

这是"甚至能指定特定对话中是否使用 Jev 做 gate"的那个开关。三种模式：

| 模式 | 行为 | 适合 |
| --- | --- | --- |
| off（默认） | 完全不判定，一次网络调用都不发 | 平常 |
| shadow | 每次工具调用都问 Jev，**只写记录，永远放行** | 试用、攒数据 |
| enforce | 判定结果会 `ask`（升级给人）或 `deny` | 信任之后 |

开关方式（在对话里说一句就行，agent 会调工具）：

    jev_gate({ action: "status" })                     # 看当前模式与记录目录
    jev_gate({ action: "shadow" })                     # 本会话打开影子模式
    jev_gate({ action: "enforce" })                    # 本会话真的开始拦
    jev_gate({ action: "off" })                        # 本会话关掉
    jev_gate({ action: "shadow", scope: "all" })       # 改所有未显式设置的会话的默认值

- **按会话隔离**：模式记在 `~/.dsh/jev-gate/state.json`，键是会话 ID；`*` 是所有未设置会话的兜底。
  重启不丢，不同对话互不影响。
- **影子记录**：`~/.dsh/jev-gate/shadow-YYYY-MM-DD.jsonl`，每条含工具名、参数预览（默认截断到
  300 字符）、Jev 的判定、耗时、以及"如果真拦会怎样"。
- **豁免**：`jev_gate` / `jev_judge` 自身，以及顶层的 `run_code` 包装器（真正要判的是它内部的
  子调用，那些会被判）。
- **失败降级**：Jev 超时、报错、没配 key → 直接 `next()`，交回 DSH 既有的权限链。
  **既不默认放行、也不卡住调用。**
- **KV cache**：Jev 调用是独立 HTTP 请求，不进 ds 的对话前缀；判定结果只在 `deny`/`ask` 的
  reason 里出现，走工具结果**追加**。所以不影响 ds 的 KV cache。

热插拔：

    dev_reload_package  packageName = dsh-jev    # 改完代码热重载，不用重启
    dev_uninject_plugin match = dsh-jev          # 随时摘掉，监听与工具一起清理

## 闸门走过的路径（记录里的 path 字段）

每条影子记录都带一个 `path`，用来区分"判定器说安全"和"判定器没答出来所以放行了"——
只看 pass / ask 是分不出来的：

| path | 含义 | 是否受保护 |
| --- | --- | --- |
| `jev` | 判定器正常作答 | 是 |
| `llm` | 判定器放权，由带上下文的 LLM 分类器接管 | 是 |
| `tier0` | 确定性规则给出结论，没走模型 | 是 |
| `skip-observe` | 只读 / 自省工具，按名单跳过 | 不需要 |
| `cache` | 同会话同形状，复用上次结论 | 是 |
| `shape-approved` | 该形状已被人工批准过（默认关闭） | 是 |
| `failopen` | 判定失败且按确定性风险判定为低风险 → 放行 | **否**（同一条记录里 `unprotected: true`） |
| `failclosed` | 判定失败且属高风险 → 改问人 | 是 |

## 减少调用次数与延迟

四层降噪，按收益排序：

1. **只读跳过**（`gateObserveSkip`，默认开）：`read` / `grep` / `glob` / `job_output` /
   `cordis_inspect_*` / 只读的知识库查询等约 24 个工具直接不判。回溯 2026-09-18 的真实日志，
   这能跳过 46.8% 的判定、省掉 39.3% 的判定耗时与约 11.5 万输入 token。
   刻意**不**收联网读取（`web_search` / `github_get_*`）——"数据离开本机"本身就是要观察的事；
   也不收任何某个参数下会改状态的工具（例如 `edge_reaper` 的 sweep）。
2. **形状缓存**（`gateCacheTtlMs`，默认 60 秒）：同一会话里同样的工具 + 同样的参数，结论必然相同，
   直接复用。参数超过 16 KB 时不做缓存——把上百 KB 的参数当键既占内存，也几乎不可能被复用。
3. **人工批准记忆**（`gateApproveOnceTtlMs`，默认 0 = 关闭）：闸门抛出 `ask` 之后，只要这次调用真的执行到了
   `tools/post-execute`，就说明人工点了"允许"；该形状在有效期内免问。执行失败（`isError`）不算批准。
4. **参数裁剪**（`gateArgChars`，默认 2000）：通用闸门与 CU 闸门都做裁剪。没有它，一次大写入就能把 state
   顶过 `maxStateChars`，判定直接失败、闸门静默失去保护。

另外，**端点各有各的预算**：整条链路的预算是 `gateTimeoutMs`，按剩余端点均分。
不分的话第一个端点会吃光全部超时，备选端点拿到的是一个已经中止的信号——它报出来的"超时"是饿死，不是真的慢。

## 放权：判定器拿不准时交给带上下文的 LLM

判定器只看得到"工具名 + 参数 + 工作目录"，看不到会话。所以它有一类失败是**结构性的**：
参数里只有一个文件名或一个编号时，它没有任何依据，却仍然会给一个高分。

`escalateMode` 打开后，闸门在这些情况下把决定权交给主模型（`ctx.llm.stream`），
带上工作目录、**最近几条真人指令**（跳过插件注入的技能目录与框架文本）和最近几次工具调用：

| 触发 | 条件 |
| --- | --- |
| U1 信息不足 | 参数里没有任何描述"这次动作做什么"的内容（只有路径 / 编号 / 标量，或关键值已被脱敏），**且判定器自己也不自信**（`escalateThinConfidence`，默认 0.8）。实测 299 条真实调用属于"参数无描述"，其中 276 条判定器以 0.94 的平均置信度放行——按包名/文件名/按键就能判的那类调用放权纯属白花一次大模型往返，收紧后降到 61 条 |
| U2 贴着分数线 | 判定分数与阈值距离小于 `escalateMargin`（默认 0.10），等于掷硬币 |
| U3 维度矛盾 | 结论自相冲突：判"只读"却把"越出工作目录"给到 0.9；判"仅观察"却把"撤回难度"给到 1.0 |
| U4 低置信 | 判定器自报置信度过低——**默认关闭**。实测 600 条里按置信度分档后，"高置信"的一致率 67%、"低置信" 76%：置信度没有区分力，要先校准再用 |
| U5 判定失败 | 端点超时或返回结构不符 |

- `shadow`（默认）：**只记录，不改变处置**，用来收放权率与误停率；
- `enforce`：LLM 的结论接管处置——可以更严，也可以**更松**，更松正是放权的意义所在。

成本与边界：主模型一次判定约 1.2 秒、单价约为判定器的 6.6 倍，所以放权必须有预算上限
（`escalateMaxPerSession`，默认 40）且默认只影子运行。模型输出必须是一个 JSON 对象
`{"decision":"allow|ask|deny","risk":"low|medium|high","reason":"..."}`；不按协议作答就退回原结论。

## 运行时注入的两个工程注意

- **不要 import `@deepseek-ai/dsh-llm`**：运行时注入的插件解析裸模块走 profile 的 `node_modules`，
  那里没有这个包；引用它会让整个插件加载失败（`dev_inject_plugin` 返回 `host ✗`）。
  需要构造消息时自己写 `{ id, role, content, source }` 即可。
- **加载期异常会落盘**：fiber 加载失败时 harness 只标 `[failed]`，看不到堆栈。
  `~/.dsh/jev-gate/load-error.log` 记录装配期异常；排查"注入后 host ✗"先看它。

## 在 DSH 里，ds 现在在哪做语义判断

接 Jev 之前先看清楚"接哪儿"。DSH 自己和周边插件里已有的判定点：

| 位置 | 现状 | 换成 Jev 的收益 |
| --- | --- | --- |
| packages/experimental/auto-review/src/index.ts:612 classifyRisk | 组 GenerateOptions 调 ctx.llm.stream，:560 parseDecision 解析 {risk, decision, reason} | 最直接：JSON 进 JSON 出，换成 choice/score 后从 ~1s、几百 token 降到 ~100ms，还多一个 confidence 可做三分支 |
| 注入插件 dsh-auto-mode（tools/pre-execute 挂钩，两段式 classifyFlash / classifyPro） | LLM 分类 allow / block / uncertain | 同一挂钩，判定下沉 |
| dsh-cost-optimizer src/classifier.ts:20 classifyComplexity | 纯启发式硬编码（长度、图片、工具结果计数） | 质量更高，但引入网络依赖与超时，需要降级路径 |
| dsh-save-money src/balance-bars.ts:61 classifyModel | 字符串包含匹配 pro / flash / vision | 同上 |
| packages/session/session-title-llm、packages/compaction/compaction-basic | ctx.llm.stream 生成摘要 | 收益是生成质量而非判定，换 Jev 不合适 |

最干净的落点是 **tools/pre-execute** 这个 hook：它的返回值就是
{ kind: 'allow' | 'deny' | 'ask' }，本来就是为"判定"设计的。

## 设计约束（照着用，别绕开）

- **一个问题只问一件事。** 复合判断要拆成多个原子问题，自己在代码里加权组合。
- **置信度是第二根轴。** choice / score 带 confidence；< 0.5 表示模型真的不确定，不要硬猜，
  退回确定性逻辑或交给人。
- **别名会漂。** jev-latest 会指向新版本，答案分布可能变；准备调阈值时钉版本号
  （如 jev-1.13.0），响应里的 model 字段会告诉你这次是谁作答的。
- **只吃文本。** 图片/音频要先转文本。英文准确率明显高于中文（含 CJK），非英文负载要自测。
- **出站代理**：本插件直接用 global fetch，没接 @deepseek-ai/dsh-http-proxy。需要走代理的
  环境要自行补 dispatcher。

## 成本

Jev 1.13：输入 $0.042 / 百万 token，输出免费，约 100ms 一次调用，单请求上下文 64k。
比生成式模型便宜 1-2 个数量级，所以"多问几个问题"通常比"多跑一轮 agent"划算。

## 版本策略

版本号保持在 **0.x**：在 1.0 之前不承诺公开接口稳定，配置键、记录字段与服务签名都可能随需要调整。

## 测试

    npm test                   # 全部离线用例，不需要 key（下面每一行也可以单独跑）

    node tests/smoke.mjs           # 两条通道、三层 key 解析、401 分支
    node tests/smoke-gate.mjs      # 通用闸门：三模式、会话隔离、降级、落盘、控制工具
    node tests/smoke-cu-gate.mjs   # CU/BU 闸门：命中与跳过、参数脱敏、判决规则、端点回退、运行时覆盖
    node tests/smoke-visibility.mjs# 浏览器可见性分类器的降级路径
    node tests/session-isolation.mjs # 每会话模式表不会外溢
    node tests/smoke-routing.mjs   # 只读跳过名单、风险分档、失败降级方向
    node tests/smoke-cache.mjs     # 形状缓存、人工批准记忆、端点预算公平分配
    node tests/smoke-escalate.mjs  # 放权触发条件、上下文快照、输出解析、接管行为
    node tests/smoke-limits.mjs    # 参数裁剪、形状键上限、有界上下文扫描
    node tests/smoke-merge.mjs     # 其它插件把规则挂进同一次 Jev 调用（贡献者注册表与合并口径）
    node tests/composition.mjs     # 真实 cordis 上下文里的装配（服务与工具注册）
