[English](README.md) | 简体中文

# pi-discovery

Pi 编码 Agent 的统一能力发现与轨迹审查扩展，以单个 Pi 扩展包提供三件事：

- **统一能力发现**：覆盖宿主 `tool_search`，按自然语言或精确名称发现并加载 Skill、MCP 与延迟工具；
- **自动准备**：接收用户输入后、首个主模型请求前，预测当前任务需要的能力与下一步动作；
- **周期轨迹审查**：每 N 步对照系统提示、Skill 原则与用户请求审查执行轨迹，产出极简二元组提醒。

自动能力/动作预测与周期轨迹审查是**不同入口、不同提示模板、不同输出**，只复用无工具的模型请求适配层。

基于官方 `@earendil-works/pi-coding-agent`（`openai-completions` 模型 API），需要 Node.js 22.19+。自动准备与周期审查依赖 [pi-snap](https://github.com/arkkwang/pi-snap) CLI 读取执行轨迹；手动 `tool_search` 不需要。

## 安装

```bash
pi install npm:@arkkwang/pi-discovery
```

或克隆本仓库后在仓库根安装本地包：

```bash
pi install .
```

轨迹相关功能另需 pi-snap **≥0.5.0** 在 `PATH` 中（`npm install -g @arkkwang/pi-snap`），支持显式 `trace` 视图；旧 `--preset`／`--trace` 参数已移除。本扩展不会自行升级命令。CLI 缺失或失败时预测/审查显式失败，由外围 warning 与 diagnostic fail-open 保持主任务可继续。

## 配置

```json
{
  "capabilityDiscovery": {
    "provider": "zai-coding-cn",
    "model": "glm-5.3-flash",
    "capabilityPrediction": true,
    "actionPrediction": true,
    "trajectoryWarnings": true,
    "trajectoryWarningEverySteps": 15,
    "maxSuggestedActions": 3,
    "autoRecommendThinkingLevel": "low",
    "toolSearchThinkingLevel": "medium"
  }
}
```

写入 Pi 的 `settings.json`。缺省值与显式配置不同：三个功能缺省关闭，模型缺省 `llama/iq3`，周期缺省 5，动作上限缺省 3，两种思考级别缺省均为 `medium`。旧键（`trajectoryWarningOnUserInput`、`autoRecommend`、嵌套 `prefetch` 及其他未知键）不被接受，会让整份 `capabilityDiscovery` 配置被拒绝。

| 入口 | 调用与输入 | 输出 |
| --- | --- | --- |
| 接收用户输入后、首个主模型请求前 | 只调用 `runPrefetch`；能力目录、当前请求/近期背景；动作启用时另加项目索引、已保留读取和动作预算 | 对象中的 `suggestions`、`actions`，只含启用字段；**绝无 warnings** |
| 每 N 步 | 只调用 `runTrajectoryReview`；执行轨迹、仅 Skill 的名称/description/路径表、主 Agent 当前系统提示词、用户请求 | 极简二元组列表；无问题为 `[]` |
| 手动 `tool_search` | 自然语言查询使用独立语义搜索；精确名称/列表无需模型 | 能力建议及实际加载结果 |

- 一步是 SDK `turn_end`：一轮 Assistant 及其工具执行完毕；并行工具批次算一步。新用户输入重置计数。每到 N 步就审查，不先猜测有没有问题；不添加错误/风险预筛选。已取消的调用不派发。
- `trajectoryWarningEverySteps` 为 0–1000 整数，0 关闭周期。`trajectoryWarnings=false` 同样关闭审查，但不影响开头的能力/动作预测。
- `maxSuggestedActions` 为 0–8 整数。动作关闭或预算为 0 时不扫描项目树、不执行动作。
- 自动准备与周期审查使用 `autoRecommendThinkingLevel`；手动搜索用 `toolSearchThinkingLevel`。支持 `off/minimal/low/medium/high/xhigh/max`，映射由模型决定，不受主会话思考级别影响。
- 每次触发最多一次模型请求，共享该触发的 60 秒预算；无自动重试/压缩。周期提醒进入下一次自然发生的主模型请求，不强制续跑、不中断成审批门禁。
- 推荐不是执行授权，结构校验也不能保证模型语义准确。

## 周期审查：帮助做好、做完、做对

审查的重点是需要的方法没及时用上、跳过必要前提、方向偏离、推进失效、虚假完成，而不是全面合规审计或检查该用哪个 MCP 工具。

原则来源是实际提供的系统提示、用户请求和 Skill 表；执行轨迹是评判对象。Skill description 只能支持原文表达的方法与适用场景，不能编造其正文原则，也不会自动读取或展开子文档。规则须对应当前任务、对象和阶段，不因目录同属一个父路径就把其他待拍板事项套过来。

输出示例：

```json
[["尚未确认统计口径就开始实现；先向用户确认活跃用户定义。", "用户请求：先向我确认活跃用户定义。"]]
```

每项恰为两个非空字符串：`[哪里偏了及该怎么做, 原则来源及原文]`。没有多字段对象、observed/missing-evidence 或凑数目标。正常进行中、未来义务未到期、摘要缺少信息、已纠正历史、正确行为或表扬都不产生提醒。提醒仍依赖模型判断，不是确定性安全检查。

## 模板、Schema 与宿主校验

- `prompts.js` 分别提供准备与审查模板。System 只写固定职责和格式指导；目录、路径、预算、主 Agent 系统/用户内容和输出 Schema 放 User 中，不把动态材料升为审查模型的系统权限。
- 准备 Schema 随启用字段选择形状，但不随目录、路径或预算增长；`suggestions.id` 和 `read.path` 是 string。手动搜索也移除目录 ID enum。审查 Schema 固定为数组套二字符串数组。
- 请求携带 `response_format.type=json_schema, strict=true`；宿主仍逐项验证当次能力 ID、实际候选 path、动作上限和参数约束。未知 ID/path、额外 warnings 字段或错误二元组会拒绝；不靠宽松解析修复模型返回，不自动重试。
- 一些兼容服务不严格执行 Schema。实际 Flash 曾把非空二元组输出为非法的 `[{"字符串","字符串"}]`；模板现在明确给出完整 `[["提醒","来源及原文"]]` 示例，外层仍严格拒绝错误格式。

## 自动准备与读取复用

隔离 SDK session 不加载用户扩展、MCP、项目指令或工具。模型仅选择建议，宿主随后执行允许的 `read`/Bash；结果不再送回预测模型。准备功能不进行轨迹审查。

- 能力目录含 Skill、MCP 与 deferred/codemode 工具，hidden 工具不进入；不等待 MCP 就绪、不自动激活。主模型按需用 `tool_search` 加载。
- Skill 的名称、完整 description、SKILL.md 路径放在同一条目；最多自动读入口，内部参考资料由主 Agent 选择。
- 项目索引广度优先，最多 3 层/200 条/6000 字符/2000 访问条目、100 ms；尊重局部 `.gitignore`，跳过隐藏目录、依赖/构建目录和凭据名，不跟随目录符号链接。遗漏不证明不存在。
- 项目文件使用 `project:<relative-path>`，Skill 使用目录内真实路径。读取前复查候选路径、真实目录范围、文本类型与大小：单文件 50,000 字节、总量 100,000 字节。
- Bash 为模型生成的非空命令，最多 2000 字符、无 NUL，原生工具超时 2 秒。提示优先只读，但**这不是程序强制只读沙箱**；不保证任意命令无副作用。
- 读取去重使用当前有效上下文投影，不能拿历史轨迹当作正文仍在的证据。完整成功且未被上下文编辑/潜在修改失效的读取才直接覆盖；部分读取、失败、压缩移除不覆盖。Bash/不透明工具保守使新鲜度失效；若选中文件还有完整留存正文，则只核对该文件，内容相同才跳过再次读取。符号链接别名不合并。

## 执行轨迹与事件

两条入口都异步调用 `pi-snap <sessionManager.getSessionFile()> --view trace --max-chars 0 --tail 160`，显式选择当前分支的 User／Assistant、工具调用发起、行为推荐和已有纠偏提醒，排除 thinking、图片和工具结果（包括错误与预取结果）。`--max-chars 0` 避免正文先被逐行截断，再由下述总预算保留最近内容。视图负责筛选与单行展示，行内带真实来源标签链，工具名移入正文（`→ read`、`← read`），不依赖 pi-snap 的默认输出，也不推断调用是否成功；完整证据可按输出序号展开。本扩展不解析历史消息生成另一套轨迹，读取去重仍独立使用 SDK 有效上下文投影。

宿主通过固定 Bash 命令 `exec pi-snap "$@"` 传独立参数，兼容 Git Bash/macOS Bash，不拼接路径进 shell 脚本，不查安装目录、不新增本地 npm 依赖。单次 CLI 超时 5 秒，继承触发取消信号，stdout/stderr 缓冲各限 8 MiB；这部分包含在 60 秒总预算内。只对输出字符串保留近期 6000 字符并标明截断，不重新解释语义；开头当前请求独立保留首尾约 4000 字符。工具参数或早期记录被省略不证明它们不存在。

文件契约已用 SDK 验证：消息/工具结果同步 append，turn_end 位于保存之后；单纯 branch() 只改内存，但本扩展在读取前已有 `capability-prefetch-diagnostic/start` 同步 append，将文件末记录连到当前活动分支。这个写入失败就明确报错并跳过预测/审查，不读可能过时的分支。首输入之前没有历史消息时正常空背景，不调用 CLI；有历史而文件不可读、CLI 缺失/失败/空输出均明确失败，由外围 warning + diagnostic fail-open 保持主任务可继续，不回退自制轨迹或伪装空历史。

## 会话与宿主整合

- 准备与审查各建文件持久化子 session，保存实际输入和原始模型输出；失败也留证据。准备 session 标明 host 执行来源并保存真实工具结果。主会话诊断条目记录子 session 绝对路径、请求数、耗时及失败状态，不进入主模型上下文。
- 子 session 使用 SDK 默认 `sessions` 存储，cwd 固定为 `path.join(os.tmpdir(), 'pi-discovery')`，正常出现在 Pi 会话列表，不设置自定义 sessionDir、不隐藏。预测模型与资源加载器沿用该 cwd；项目索引、准备动作仍使用主任务 cwd。文件名保持 SDK 默认 `timestamp_ID.jsonl`；session 名为 `pi-discovery · preparation|trajectory · provider/model · 完整sessionID`，origin 保留父 session ID/文件/叶子 ID。可直接 `pi-snap <ID前缀>` 查阅。
- 输入准备由 `context` 钩子执行：`before_agent_start` 只整合目录、保存本轮请求，不等待推荐模型。宿主先确认接收并保存用户消息，然后在主模型请求前等待推荐。当前请求直接使用结果；`sendMessage(..., {triggerTurn:false})` 在安全轮次边界将同一结果保存为 `capability-prefetch`，不触发额外模型轮次。后续上下文投影只展开工具记录，不重演执行。
- 同一轮共用一个准备 Promise；重复上下文变换、请求重试和后续工具轮次不重复推荐/保存。取消、切会话、切分支、结束运行使待处理结果失效；已落盘载体被压缩或 context edit 移除后，不从内存缓存复活。周期二元组仍在 `capability-trajectory-warning` 中落盘。
- `index.js` 使用运行中 Pi 的公开 MCP/tool-search 工厂，不安装第二份 SDK。保留原 tool_search schema 对象身份、model-only/defaultActive、MCP 连接/OAuth/权限和 BM25/激活逻辑。
- 包装 MCP 的 `before_agent_start`，原目录生成后合并成唯一能力目录。Skill 的 `metadata.catalog-description` 只用于主模型短目录；语义预测/审查仍用宿主完整 description。每次输入读取已解析 Skill 文件元数据，不扫描目录。
- 工具加载沿宿主机制，不反复卸载。Astra 支持追加 `additional_tools`；其他接口可能更新顶层 tools，本插件不承诺所有模型零前缀缓存损失。

### 从主会话排查推荐与审查

主 JSONL 的 `customType: capability-prefetch-diagnostic` 是排障索引，不进入模型上下文。新增记录带 `version: 1`、每次用户输入的 `inputId` 和记录前的 `parentLeafId`；一次预测/审查用 `attempt` 关联，预取载体与交付用 `preparationId` 关联。

| 事件 | 能确认什么 |
| --- | --- |
| `input` | 当次 `configuredOptions` 总配置、预取是否安排、用户新输入清零前的 `resetFromSteps` |
| `gate` | 每轮结束为何审查或跳过：`due` / `below-interval` / `disabled` / `zero-interval` / `cancelled` / `invalid-settings`，以及当前 `steps`、`interval` |
| `start` | 总配置 `configuredOptions` 与当前路径 `effectiveOptions`；预取路径关闭轨迹审查不表示总开关关闭 |
| `session` / `review-input` | 子会话路径及审查输入来源、字符数和轨迹截断情况；完整实际输入与原始模型输出在子 JSONL |
| `complete` / `failure` | 请求、动作、耗时、失败；审查明确区分 `warnings`、`no-warnings` 和 `failed` |
| `context-ready` | 首次上下文钩子交出预取结果：`direct` 直接注入、`history` 已在上下文、`removed-from-context` 不复活已移除内容、`no-message` 无预取载体；含投影工具调用 ID |

用 `pi-snap SESSION --only customType:capability-prefetch-diagnostic` 定位诊断记录，再用 `pi-snap SESSION ENTRY --json` 看字段；ENTRY 可用输出序号或原始 ID。`childSession.file` / `id` 指向完整推理证据。实际执行参数/结果保存在 `capability-prefetch.details.prefetch.rounds[].messages`，其数字毫秒时间是动作时间，父记录时间可能是延后落盘时间。不要用父记录的排列位置判断预取是否晚于主执行。

证据边界：`context-ready` 只证明本扩展交出的上下文，不证明 provider 已接收或模型遵守；后续宿主处理仍可能改变请求。审查当前只接收系统指令、当前用户请求、Skill 描述及有界轨迹，不含完整已读 Skill 正文或工具结果正文；`review-input` 明示这一覆盖范围。不把审查无提醒等同于操作已获授权。旧日志缺少这些新增事件时，不反推总配置或未触发原因；进程崩溃、日志写入失败也可能留下未完成的 attempt。

### 接收确认与推荐耗时分离

真实 Pi SDK 隔离测试以假 provider / 假推荐器代替外部模型，不发网络推理：将推荐固定阻塞10秒，实测接收确认约3ms返回，用户消息与会话文件已经存在，主 provider 请求仍为0；释放推荐后主模型才收到带建议的请求。工具轮次不重复推荐，取消后的迟到结果不进入下一次输入。另有并发 context、会话切换、已移除上下文不得复活的回归。这里测的是 SDK 确认边界，不是 HTTP/移动端整链延迟；MCP 连接和会话初始化的等待仍可能存在。

## 手动搜索

```json
{"query":"打开网页检查交互反馈，并修复代码问题","limit":8}
{"query":"skill:engineering-practice"}
{"query":"mcp:mcp__playwright"}
{"query":"notify"}
{"query":"*","limit":100}
```

自然语言按完整 description 语义推荐，再在选中范围内调用原生搜索；精确名称忽略大小写，`skill:`/`mcp:`/`tool:` 消歧。`*` 只列目录，不推理/加载。保留原工具参数，limit 缺省 8，无 offset。返回 `mode/total/suggestions/loaded/availableTools`；已加载工具不重复激活，Skill 需读正文。confidence 是未校准的模型自评相关度，不是执行门槛。模型失败明确给 `routingError` 并尝试原生搜索，不冒充完整无匹配结果。

## 验证

在仓库根运行：

```bash
npm test
PI_DISCOVERY_SDK_ROOT=<Pi包目录> npm test
# 四个预先固定的 Flash 探针，不执行 Bash/MCP/准备动作：
PI_DISCOVERY_SDK_ROOT=<Pi包目录> PI_DISCOVERY_OBSERVER_LIVE=1 node --test test/observer-live.test.mjs
```

涉及轨迹的测试用临时 PATH shim 指向兄弟 `pi-snap` 源码仓库，也可设置 `PI_SNAP_SOURCE=<源码仓库>`；兄弟源码不存在时相应测试自动跳过（显式设置的 `PI_SNAP_SOURCE` 路径无效则直接失败）。真实 SDK 测试另需 `PI_DISCOVERY_SDK_ROOT`。

确定性测试与真实 SDK 回归在 GitHub Actions 的 Ubuntu/macOS/Windows 矩阵运行；live 测试（真实模型请求）默认跳过，只在显式设置对应环境变量时执行。

### 已知边界

- 周期提醒质量、误报率及稳定延迟依赖具体模型；结构校验保证格式，不保证语义正确。
- 准备动作中的 Bash 不是程序强制只读沙箱，见「自动准备与读取复用」。
- MCP 连接与 Pi 会话初始化的等待不计入本扩展预算之外的承诺；长会话下的实际整链延迟需在真实使用中确认。

## License

[MIT](LICENSE)
