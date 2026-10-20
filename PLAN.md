# 能力推荐失败自动回退全量目录 — 实施 Plan

## 任务与边界

- 用户先批准按前一轮建议实现并指定 `llama/iq3`；随后明确要求主 Agent 自行接手。iq3 已停止（`sa-5781bb84`，lastRunOutcome=stopped），核对无任何代码改动。以下实现与验证均由主 Agent 完成。
- 来源：Pi 会话 `01a137b8-dbda-7232-b0e6-0a629176af76` 的待办汇总，以及 `D:/workspace/utils/obsidian-note/90_inbox/inbox.md` 2026-10-13 pi-discovery 待办。
- 目标：路由服务 429/不可用/输出无效时，Agent 自动拿到可操作的完整能力目录（尤其 Skill 正文路径），不再依赖自行翻目录或想到 `query="*"`。
- 仓库：`D:/workspace/program/personal/pi-discovery`；计划建立时 HEAD `d74d69b`，工作树干净。
- 本文件是实现决定、进展和验证证据的共同记录；不要另建交接/验收报告。
- 范围：源代码、相关自动化测试、双语 README。允许必要的包文件清单调整，不新增依赖。
- 不提交/推送/发布、不改版本、不安装或替换运行时副本、不重启应用/服务、不修改全局配置。不用真实计费模型请求做故障测试。不修改笔记库待办，由主 Agent 收尾时决定。

## 已核对的现状

1. `discovery.js` execute 在语义路由异常后清空 suggestions，再调原生搜索；最终可能返回 isError。所有模式都执行 `suggestions.slice(0, limit)`。
2. `router.js` 是一次分类请求；HTTP/网络/JSON/结构/任一非法推荐项都会抛错。合法 `suggestions: []` 是模型提示词明确允许的无匹配结果。不要根据旧待办改成“router 只是丢弃非法项”。
3. `prefetch.js` 的 `validatePrediction` 按项保留合法 suggestion/action，并记录 dropped。模型初始化可在 runPrefetch 的 try 之外失败。现有 failure 又可能混合预测失败与行动阶段失败。
4. `discovery.js` 的 atBoundary 会吞掉外层异常；context hook 在没有 suggestions/rounds 时不投递消息。仅改 runPrefetch 的 catch 不足以解决自动降级。
5. caller signal 与内部 60 秒 deadline 经合并传给执行方：必须在拥有原始 caller signal 的边界区分取消与超时。
6. 系统 `available_capabilities` 已是静态短目录；prefetch catalog 含宿主 MCP 提示里的 pending 服务，而 execute catalog 当前只含已注册服务。
7. 测试使用 node:test；live 测试由显式环境变量控制。SDK 测试以 `PI_DISCOVERY_SDK_ROOT` 选择安装包，不能把 skipped 当作已通过。

## 行为契约（本次有效决定）

### 1. 失败、无匹配与部分成功

| 情形 | tool_search | 输入时 prefetch（能力预测已开启） |
| --- | --- | --- |
| 429/其他 HTTP 错误、网络失败、内部超时、模型/鉴权/SDK 缺失等初始化失败 | 全量降级，保留原因 | 全量降级，保留原因 |
| JSON/顶层结构无效；suggestions 缺失或类型错误 | 全量降级 | 全量降级 |
| 非空推荐列表全部为非法项 | 全量降级 | 全量降级 |
| 部分推荐项非法、部分合法 | 保留 router 现有严格验证：整次拒绝后降级 | 保留合法项，记录 dropped，不全量替换 |
| 合法 `suggestions: []` | 无匹配，无 routingError；现有原生搜索可照常尝试 | 无匹配，不注入全量目录 |
| 合法低 confidence 推荐 | 保持合法推荐，不设新阈值 | 同左 |
| 只有行动推荐无效或工具执行失败 | 不适用 | 不因此把成功的能力预测替换为全量目录 |
| caller 取消、旧会话/旧输入已失效 | 传播取消，不加载 | 不注入目录，不复活消息 |
| capabilityPrediction 关闭（含 action-only 模式） | 不影响显式搜索 | 不生成能力目录；保留现有行动逻辑 |

空 catalog 合法，不伪造能力。若确有预测失败，即使目录也为空，仍应在上下文中保留降级/错误说明，而不是静默丢掉。

### 2. 降级结果

- 保持 `mode` 现有取值（semantic/exact/list），用新增 `fallback: "full-catalog"` 标识语义搜索降级，避免破坏既有 mode 消费方。
- `suggestions` 为全部可发现 catalog entries，全部 `confidence: null`；`total === suggestions.length`。Skill 保留 path；MCP 和 tool 保留当前元数据。
- `routingError` 保留有用的失败原因（例如 HTTP 429、超时、非法推荐），不加入完整任务提示、凭据或原始模型输出。
- 明确 hint/消息文案：这是未经相关性排序的全量目录，不是推荐排名；目录不表示已加载，也不授予执行权限。稳定名称/分组顺序允许保留。
- 全量降级不受 limit 截断；`query="*"` 同样返回全量目录。输入参数仍按现有契约验证，正常 semantic/exact 仍按 limit。
- 降级成功返回目录，不把整个 tool result 标为 `isError: true`。routingError + fallback 表达“推荐失败、目录仍可用”。
- 降级与 list 均不调用原生搜索，不新增激活；loaded 为空。availableTools 如返回，应仅反映真实已激活匹配，不能声称全量目录已加载。精确名称后续加载机制不变。
- 不换备用模型、不重试分类请求、不增加等待链。

### 3. catalog 一致性与边界

- 尽量复用现有目录构建逻辑；保留禁用 Skill、hidden tools 等过滤条件。
- 为 execute/list/fallback 保留本会话宿主声明的 MCP namespace（包括 pending），与已注册 namespace 去重合并；不连接服务、不自己扫描用户目录来补目录。
- pending 元数据应在新 before_agent_start 更新/清空，避免跨会话或新配置残留。每次 execute 仍读取当前注册工具。
- Skill paths 必须来自可信 catalog，不能采用模型生成路径。
- 只抽取确实复用的少量纯函数；不为三个结果状态构建通用恢复框架。如新增运行时文件，必须加入 package.json files。

### 4. prefetch 的分层责任

- 校验层继续维护按项容错；对“能力预测无有效结果”的错误给出可判断的状态/原因。动作字段损坏不得被误认为能力字段失败。
- 执行层区分预测阶段和行动阶段。HTTP/解析失败或全无效建议应产出降级目录；现有合法 actions 按既有授权/校验机制处理，不从全量目录派生新动作，不自动读全库。
- 保留已有 action rounds、错误标记和请求次数，不能因降级隐藏已发生的准备动作；仅有行动执行失败时保留有效推荐。
- 外层用户输入准备边界兜住 SDK 不可用、模型设置错误、上下文准备失败等异常；不得把同样的回退套到 periodic 轨迹审查上。
- 内部 deadline 是失败可降级；caller abort / preparation 被 invalidate 是取消必须抑制投递。边界调用方持有原始 caller signal，不靠异常字符串猜测用户取消。
- 降级字段/原因同时进入持久 custom message 的 details 与实际 content。context hook 判断“是否有消息”必须计入降级状态，重复 context hook 只投递一次。
- 保留已有 session/input identity 检查、取消、history 去重以及压缩移除消息后不复活机制。
- 系统能力短目录不重复扩写全文/路径；必要的全量详情在降级消息里提供。

## 实施切片与依赖顺序

### A. 建立回归与基线

1. 阅读 `discovery.js`、`router.js`、`prefetch.js`、`model-request.js` 与相关 tests/README。
2. 用无 live 的默认测试记录基线，区分 skip 与失败；SDK root 可只读定位现有安装，禁止安装新包。
3. 先更新旧的“路由失败后原生搜索”的断言，并新增 429 + limit=1 + 混合目录的回归，确认按旧行为失败而非环境错误。

### B. 完成显式发现降级

1. 整理可复用目录与降级结果构建逻辑，纳入宿主 pending namespace，保持刷新和去重。
2. execute 路由 catch 建立全量降级；分开正常推荐的加载路径与目录-only 路径。
3. list/fallback 不 slice；更新 isError、hint、fallback 元数据。
4. 跑 search/router 测试，确认正常语义加载、exact、schema identity 未回归。

### C. 完成 prefetch 自动降级

1. 为预取预测的非法/无匹配/部分有效情况增加明确断言，再改校验与错误状态。
2. 区分预测结果失败与行动执行失败，保留 rounds 和 diagnostics。
3. 在用户输入准备边界处理 outer setup failure、内部 deadline 与 caller cancellation。
4. 将降级状态投递到 custom message 内容和 details，修复空结果 gate；保证只投递一次。
5. 跑 prefetch/auto/session-storage 等受影响测试。不要为通过测试删除现有取消、压缩或持久化断言。

### D. 文档与整体验证

1. 同步 README.md / README.zh-CN.md 的发现工具、limit、失败与预取说明；正常语义搜索仍可自动加载，失败降级与 list 不加载。
2. 跑默认全套；可用时跑现有真实 SDK + stub 模型的集成套件，保持所有 LIVE 开关关闭。
3. `git diff --check`，复核运行时文件打包清单（如新增模块，可 `npm pack --dry-run --ignore-scripts` 只检视文件清单，不发布）。
4. 本文件填写实际命令、结果/跳过项、红灯证据、遗留问题；交主 Agent 复核。

## 必须覆盖的验收矩阵

### tool_search / router

- [x] 模拟 429，返回 Skill（含 path）+ MCP + deferred + codemode 全量；无相关性 confidence；包含 routingError/fallback。
- [x] 网络异常、内部超时、无模型/鉴权、非法 JSON、非法结构/ID/score 均降级；每次最多一次模型请求。
- [x] 目录 > 默认 limit，且 limit=1 时 fallback/list 均不截断。
- [x] fallback/list 不调用 native execute/setActiveTools；既有 active tools 状态不变。
- [x] hidden/disabled 不泄漏；pending MCP 不遗漏；同 namespace 不重复；新 prompt/工具变化可刷新。
- [x] 合法空数组不误判失败；正常排序与 limit、精确 Skill、精确 MCP/tool 激活与 next-call 语义不变。
- [x] caller 预取消/执行中取消不变成全量成功，不触发加载。

### prefetch / context hook

- [x] 模拟请求 429/解析失败，实际 content 和持久 details 有完整目录与 routingError，不只存在内部 diagnostics。
- [x] SDK 缺失、模型初始化/上下文准备异常也能投递降级消息。
- [x] 内部 deadline 可降级；caller abort、session switch/agent_end/new input 使旧结果失效，不注入。
- [x] 合法空建议不回退；能力字段缺失/类型错/全部无效回退；部分有效继续保留并记录 dropped。
- [x] 能力预测关闭、仅 action prediction、全关闭均不产生全量目录。
- [x] 能力预测有效但 action 失败不误回退；能力降级不新增读文件/bash/工具激活动作。
- [x] 保留已执行合法 action rounds 及其真实成功/失败；请求不重试。
- [x] 重复 context transforms/retries 不重复投递；resume/fork/compaction 现有投影与不复活行为保持。
- [x] 空 catalog + 真实失败仍给明确降级/错误信息，合法空 catalog 不造假。

测试可以表驱动合并；不必每格单建文件。必须包含入口级断言，不能只测一个 fallback helper 就声称主流程成功。

## 实施进展与证据

### 完成情况

- A/B/C/D 四个切片已完成。`catalog.js` 统一无排序目录的输出契约；`discovery.js` 复用含 pending MCP 的目录，区分目录-only 与正常加载，并负责 caller/deadline 及外层准备失败的上下文投递。
- `prefetch.js` 根据校验丢弃原因区分合法空、全部无效、部分有效；以 predictionCompleted 区分预测与行动失败。原有 action rounds 和诊断保留，取消由拥有 caller signal 的外层抑制。
- `router.js` / `model-request.js` 避免把 JSON 解析异常中的原始响应正文带入 routingError；SDK 错误保留 HTTP 状态，完整证据仍在 child session。
- 新增入口回归 `test/fallback.test.mjs`（10 组，含表驱动多场景）；扩展现有 search/auto/prefetch/observer/SDK 测试和双语 README。新运行时模块已加入 package.json files。

### 基线与红灯证据

- Node `v22.23.2`，Windows/Git Bash；基线 HEAD `d74d69b`。
- 原 `npm test`：87 项，66 pass / 0 fail / 21 skip。日志 `%TEMP%/pi-discovery-baseline.log`。
- 先写新增前 7 组入口回归，在旧代码运行 `node --test test/fallback.test.mjs`：7 fail / 0 pass，原因是缺少 full-catalog 结果或未投递预取消息，不是环境缺失。日志 `%TEMP%/pi-discovery-red.log`。
- 旧 search 测试的“路由失败仍原生搜索”、auto/observer 的“初始化失败不投递消息”与新契约冲突，已替换为目录可用/不加载/错误可见断言，原来的取消、保密与不读过期轨迹断言保留。

### SDK 测试中的既有接口漂移

- 已安装 SDK 为 `@earendil-works/pi-coding-agent 1.2.0`。
- 初次扩展测试有 2 项失败：测试仍调用旧 emitBeforeAgentStart 三参数签名，以及引用已移除的 isToolSearchTool。
- 用 `git archive HEAD` 建立临时基线、链接现有 node_modules、运行原 `test/sdk.test.mjs`，同样 2 fail / 2 pass，确认非本次功能回归。日志 `%TEMP%/pi-discovery-sdk-baseline.log`，临时基线已清理。
- 测试按当前 SDK 使用 trigger 对象 + options；直接断言原生 toolSearchSchema 引用与 reachesTools 元数据，并继续跑真实 in-memory MCP 等待/加载断言。没有删除或跳过失败测试来制造通过。

### 最终验证

在仓库目录运行（无真实模型调用）：

```bash
PI_DISCOVERY_LIVE=0 PI_DISCOVERY_PREFETCH_LIVE=0 PI_DISCOVERY_OBSERVER_LIVE=0 npm test
# 97 tests: 76 pass, 0 fail, 21 skipped

PI_DISCOVERY_SDK_ROOT='C:/Users/win11/AppData/Local/npm-cache/_npx/2453649666e7772c/node_modules/@earendil-works/pi-coding-agent' PI_DISCOVERY_LIVE=0 PI_DISCOVERY_PREFETCH_LIVE=0 PI_DISCOVERY_OBSERVER_LIVE=0 npm test
# 97 tests: 91 pass, 0 fail, 6 skipped

git diff --check
npm pack --dry-run --ignore-scripts --json
```

- 最终日志：`%TEMP%/pi-discovery-suite.log`、`%TEMP%/pi-discovery-sdk.log`；打包清单 `%TEMP%/pi-discovery-pack.json`。
- SDK 路径下全部非 live 测试通过。6 个 skip 为 live IQ3 路由、3 个 live review 场景、live input preparation、live IQ3 full discovery。
- `git diff --check` 无空白错误；Git 有既有 CRLF→LF 规范化提示，不影响测试。
- dry-run 清单包含 catalog.js 及全部现有运行时模块；不含 PLAN.md/test，不产生发布或安装动作。

### 最终复核与证据边界

- 对照初始问题，真实 SDK loader + 原生 tool factory + 模拟 HTTP 429 已验证：limit=1 仍返回完整 Skill/MCP 目录；Skill path 指向实际可读正文；不改变 active tools；随后精确 MCP 搜索可正常加载。SDK 预取测试验证单次失败请求后返回全量目录及 HTTP 429 原因。
- context hook 入口测试验证 details/content 同时携带降级结果、空目录错误可见、并发/重试不重复投递、移除上下文不复活、取消/切换/新输入不接受旧结果。原有 SDK resume/fork/投影测试通过。
- 未做 live 模型行为效果测试；结论限于确定性的降级、上下文交付与宿主加载契约，不宣称真实 Agent 已长期改善。
- 已完成源代码和文档交付；未提交、推送、发布、更新运行时副本或重启服务，未修改笔记库待办状态。当前运行中的扩展不会因本次源代码改动自动切换。


## 后续切片：按阶段聚合模型配置（用户新增要求）

### 有效契约

- 用户要求两个阶段各自选择 `provider/model`，并将各阶段配置聚合，取消顶层平铺。
- 新结构：`capabilityDiscovery.recommendation` 与 `capabilityDiscovery.trajectory`。
  - recommendation：`model`、`capabilityPrediction`、`actionPrediction`、`maxSuggestedActions`、`thinkingLevel`、`toolSearchThinkingLevel`。自动准备和显式语义搜索共用此阶段模型；精确/列表模式仍不调用模型。
  - trajectory：`model`、`enabled`、`everySteps`、`thinkingLevel`。只控制周期预警。
- 两阶段默认 model 各为 `llama/iq3`，不会隐式跟随另一个阶段。各 thinkingLevel 默认 medium；其他默认行为保持（推荐/动作/预警默认关闭，动作上限 3，间隔 5）。
- model 按第一个 `/` 分割，provider 和 model ID 均非空，支持 model ID 自身含 `/`；拒绝空白、缺少分隔符或非字符串。
- 旧平铺字段、错误层级和未知字段显式拒绝，不静默迁移或忽略；README 提供完整迁移示例。不修改本机 settings.json。
- 内部实现同步按阶段传参：prefetch/router 收 recommendation 选项，review 收 trajectory 选项，共享请求层只读当前阶段的 model/thinkingLevel。诊断同时保留整体 configuredOptions 和阶段 effectiveOptions。

### 实现与验证顺序

1. 添加入口级失败回归：两个不同模型/思考级别分别用于两个触发，tool_search 使用推荐阶段模型，旧配置拒绝。
2. 提取集中配置校验/模型引用解析，更新三个调用入口与共享 SDK 请求、子会话名称。
3. 迁移既有 fixture 与断言（保留回退/取消/轨迹测试覆盖），增加 slash 模型 ID 与严格校验边界。
4. 更新中英文 README 与打包清单；运行默认及现有 SDK 测试，LIVE 开关继续关闭。

### 完成与验证

- 已完成。`config.js` 集中维护两组默认值、严格字段校验、思考级别与 provider/model 解析；prefetch/router/review 分别接收自己的阶段配置，共享请求层仅使用当前阶段 model/thinkingLevel，子会话名称也记录正确模型。
- 顶层只有 recommendation/trajectory；旧平铺结构与错误层级显式拒绝。示例保留用户原来的 Flash/low 选择，两个模型与思考级别可独立替换。本机 settings.json 未修改。
- 新增 `test/stage-models.test.mjs` 6 组测试：入口实际选择两个不同 provider/model（含 model ID 内的 slash），不同 thinkingLevel，手动搜索使用推荐模型；阶段独立启停；所有键/边界值/默认值；推荐模型不可用不会改用预警模型；双语 README 配置可解析且与完整 schema 一致。
- TDD：前三组入口测试在改动前均失败（3 fail，0 pass），日志 `%TEMP%/pi-discovery-stages-red.log`。随后迁移既有配置 fixture 与诊断断言，保留前一切片的回退和 SDK 行为回归。
- 最终默认测试：103 tests，82 pass / 0 fail / 21 skipped，日志 `%TEMP%/pi-discovery-stages-default.log`。
- 最终现有 SDK 1.2.0 测试：103 tests，97 pass / 0 fail / 6 skipped，日志 `%TEMP%/pi-discovery-stages-sdk.log`。命令与上一切片相同，三个 LIVE 开关均为 0；仅 6 项真实模型测试跳过。
- `git diff --check` 通过；`npm pack --dry-run --ignore-scripts --json` 确认 config.js/catalog.js 均进入包，清单 `%TEMP%/pi-discovery-stages-pack.json`。
- 中英文 README 已同步完整配置、全部 10 个嵌套键、默认值/范围、旧格式迁移与诊断字段含义。未提交、发布、安装或重启。
