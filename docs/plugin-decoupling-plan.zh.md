# EDMORE 插件解耦计划

状态：核心结构重构和隔离自动化验收已实施；第 10 步的在线部署及真实 NionSwift 验收待执行。更新日期：2026-09-16。当前采用一个必选 Core 功能包及多个可选功能包；下面的模块划分描述内部所有权，不等于全部向用户提供独立开关。

## 1. 范围与目标

以当前 `EDMORE/client`、`EDMORE/desktop` 为实施目录。`client/runtime` 的 Harness 原生实现保持不变；agent loop、工具执行框架、session 和 session-persistence 继续使用原生能力。NionSwift MCP server 的现有接口保持稳定。

“全部解耦”定义为：业务功能具有独立所有者、数据和生命周期；依赖关系单向且显式；可选功能关闭不使无关功能失效。基础服务仍是必要依赖。缺失必要能力时明确停用相关功能，不使用旧 Python 编排、关键词路由、内存持久化替代或空实现作为 fallback。

## 2. 重构前的耦合基线

| 当前包 | 耦合点 | 影响 |
|---|---|---|
| backend-profile | 组合原生服务与全部 EDMORE 功能 | 是配置 bundle，不是独立业务服务；当前开关未校验组合 |
| backend | inject 强依赖 plan-judge、session-state 和多项原生服务 | 任一业务依赖缺失都可能阻止后端启动 |
| backend | 内部创建 event hub、动作去重、MCP bridge、模型配置、角色管理、workflow、agent adapter、HTTP/SSE、WebUI | 无法分别关闭或独立测试这些能力 |
| plan-judge | inject skills、session-state；由 backend 创建实例，再 bindRoleRunner | 编排实例的创建与执行器绑定构成双向装配关系 |
| MCP tool bridge | 直接调用 workflow.beforeLoopToolCall/afterLoopToolResult/handleLoopToolError | 普通工具传输与计划约束绑在一起 |
| agent adapter | 直接调用 workflow.nextLoopDispatch、bindHarnessSession | 通用模型调用与具体工作流推进绑在一起 |
| session-state | 同时拥有证据 journal、状态投影、定时 flush、HTTP/SSE/export | 关闭查看功能也删除执行依赖 |
| backend + session-state | backend replay/subscribe 写入状态库，workflow 又直接记录执行证据 | 写入责任分散；event hub 与状态 journal 存在交叠 |
| workspace | metadata store 与 HTTP 接口绑定 webServer | TUI 等无 HTTP 运行方式也被迫依赖 Web 服务 |
| conversation-title | 依赖 backend 提供 events/agent adapter，再依赖 workspace | 关闭 backend 的其他功能会连带阻断标题生成 |
| WebUI | 启动时直接请求 workspace、session-state、workflow 等 API | 没有统一能力发现，禁用功能后仍可能请求、订阅缺失接口 |
| desktop PluginManager | toggle 仅写 disabled patch | 未预检硬依赖、受影响能力和执行状态 |

另需清除 plan-judge 中 sessionState 缺失时转而使用 plan.execution_context 的第二条运行路径。历史数据可单次迁移，运行期只保留一个证据来源。

## 3. 目标服务与插件

### 3.1 必选 edmore-core

Core 是统一安装、启动和版本管理的 Harness/Cordis bundle，内部保留独立模块与测试，不重新实现 Harness agent loop。桌面界面只显示一个 Core 状态，不允许逐项关闭其内部基础服务。

| Core 能力 | 内容与边界 |
|---|---|
| 原生执行环境 | Harness agent、agent loop、session、system prompt、tools；业务插件通过这些原生服务扩展 |
| 模型与凭据 | provider 接口、配置校验、密钥访问、role 配置、超时和调用失败报告；无可用凭据时仍可启动管理服务并查看记录，模型调用报告未配置 |
| 基础会话 | 基于原生持久化创建、列出、恢复 session，提供前端聊天投影；不要求 project/workspace，不复制另一套聊天全文 |
| EDMORE 事件 | durable event journal、命令 receipt/idempotency、cursor、replay、订阅；工具原始结果通过原生 session 引用关联 |
| 原生 Skills | 发现、读取 SKILL.md 和授权目录内的引用资料；不包含工作流步骤编译、judge 或执行策略 |
| 角色与能力注册 | 插件注册/撤销 role、tool、command、view 能力；保存的配置和当前可调用角色分开；Core 只内建普通聊天角色 |
| 任务与生命周期 | 通用运行 ID、同 session 的调度、取消、超时、资源释放、flush 和受控退出；不理解父子计划步骤 |
| 通用授权入口 | 在原生工具调用入口检查能力/授权提供者、输入和访问范围；Core 不生成工作流批准，也不替代 workflow 仪器占用状态 |
| 状态与诊断 | health/readiness、插件 enabled/blocked/failed 状态、依赖说明和结构化错误；不依赖 Session State 查看插件 |
| 客户端服务接口 | typed session、command、event subscription 接口；传输实现与 Web 页面分别装配 |

Core 的 Skills 文件读取使用原生文件系统提供者和限定目录访问。开放给模型的通用文件编辑、shell 命令、任意目录访问属于额外工具能力，按需启用；不能因为读取 skill 就自动开放这些工具。

通用授权入口始终生效。Workflow 提供具体的计划批准、skill 确认、步骤和仪器占用检查；Workflow 不可用时其受控工具授权不可用。模型仍能读取和解释 workflow skill，但不会执行受限步骤。

### 3.2 用户可选功能包

| 功能包 | 内部组成 | 硬依赖 |
|---|---|---|
| Workflow | plan-judge、workflow evidence/session-state、workflow policy provider | Core；执行涉及 MCP 的步骤时需要 MCP Bridge |
| MCP Bridge | 连接、发现、MCP 工具与 agent role 注册 | Core；受 Workflow 约束的操作需要 Workflow 授权 |
| Workspace | 项目及 conversation 索引、metadata 和手动标题 | Core |
| 自动标题 | 标题 role 和生成逻辑 | Core + Workspace |
| 状态查看 | 查询、可视化、导出工作流证据 | Core + Workflow 的证据服务；仅使用它的页面时需要相应前端 |
| HTTP Gateway | HTTP 命令、SSE、能力查询的传输适配 | Core；按已注册功能增加路由 |
| WebUI | 网页及各功能视图 | Core + HTTP Gateway |
| 扩展工具 | 通用文件编辑、shell 或其他原生工具插件 | Core 和对应原生访问策略 |

Workflow 内部的证据服务与批准检查作为一组管理，不向普通用户提供能破坏该组依赖的开关。标题插件关闭时撤销 title_generator；Workflow 关闭时撤销 planner/judge；MCP 断开时撤销对应可调度 executor，保留其用户模型配置以便重连。

当前 WebUI 和 NionSwift 依赖 HTTP/SSE，默认应用组合包含 HTTP Gateway。关闭 Gateway 会使这些客户端断开，但不等于 Core 停止。桌面应用通过自己的进程管理通道启动/关闭服务，不依赖状态查看页面。未来 TUI 只有实现非 HTTP 适配器后才能在无 Gateway 时连接。

### 3.3 内部模块所有权

以下名称为拟新增或调整名称；先固定接口与所有权，再拆文件。

| 模块 | 唯一职责 | 依赖与禁用语义 |
|---|---|---|
| edmore-contracts（普通库） | 版本化事件、命令、ID、服务接口 | 无存储、无业务实例、无 Context 副作用 |
| edmore-events | EDMORE 领域事件持久化、cursor、replay、订阅、动作 receipt | EDMORE 基础服务；不依赖 workflow、MCP 或 UI |
| edmore-agent-runtime | 模型/role 配置、Harness agent/session 映射和调用适配 | 依赖 Harness 原生运行时、events；不导入 workflow 或 MCP 实现 |
| edmore-mcp-bridge | server 连接、发现、工具注册、参数 schema 和结果传输 | 依赖原生 tools、events；不直接调用 plan-judge |
| edmore-tool-policy | Core 提供授权检查入口，Workflow 提供计划与仪器占用策略 | 使用原生工具 hook；受控工具没有有效授权者时拒绝执行 |
| edmore-session-state | 由事件和原生 session 引用生成查询投影与 evidence packet | 从 events 重建；不提供 HTTP，也不发起模型调用 |
| edmore-plan-judge | workflow 状态机、planning/judging、approval、确认、子计划栈及推进 | 依赖 events、原生 skills、session-state 和抽象的模型/工具目录接口 |
| edmore-workspace | project/conversation/session 索引及 metadata | 不依赖 webServer、workflow；关闭时原生 session 仍保留 |
| edmore-conversation-title | 监听对话并生成标题，更新 workspace | 依赖 events、agent-runtime、workspace；失败不阻断聊天 |
| edmore-client-api | 命令 HTTP、事件 SSE、聚合查询、能力信息 | webServer + events；按服务实际可用性注册功能路由 |
| edmore-web-ui | 静态页面和功能视图 | webServer + client-api；关闭不停止后台 agent/workflow |
| edmore-backend-profile | 选择插件组合、参数及依赖装配 | 不创建业务对象；不保留旧 backend 巨型装配路径 |

模型选择和 role 注册先由 Core 中的 agent-runtime 模块负责，避免增加没有独立用途的小插件。不同 role 继续独立模型配置，MCP agent 的出现与移除通过声明接口更新角色，不让模型配置层依赖 NionSwift 类。Core 不导入任一可选功能的具体实现，也不预注册其角色。

## 4. 单向调用与执行路径

用户命令 -> client-api -> durable action receipt -> 命令所属服务。

普通聊天 -> agent-runtime -> Harness 原生 agent loop。

workflow 命令 -> plan-judge -> agent-runtime -> Harness 原生 agent loop -> 原生 tools + tool-policy -> mcp-bridge -> MCP server。

MCP 结果与 Harness 原生工具事件 -> plan-judge 评估当前步骤、更新状态 -> 下一次 agent dispatch。

已提交领域事件 -> session-state/workspace/title 等订阅者 -> client-api SSE -> WebUI/TUI/NionSwift。

plan-judge 是工作流推进的唯一发起者；agent-runtime 不递归查询具体 workflow。MCP bridge 不解释 plan。授权检查是调用前必须等待的同步决策，不能用异步广播代替。普通状态通知使用事件，查询与命令使用 typed service API，不把所有调用改成事件总线。

工具完成后的处理只保留一个可去重入口，以 action_id、workflow_id、step_id、call_id 对齐；不可同时由桥接器回调和 session 订阅各推进一次。

## 5. 数据归属与迁移

| 数据 | 唯一权威来源 |
|---|---|
| LLM 对话、原生工具调用和结果 | Harness session-persistence |
| 用户动作、确认、批准、workflow 状态变化 | edmore-events journal |
| plan 定义、当前位置、子计划栈、仪器占用 | plan-judge checkpoint，关联领域事件 cursor |
| session 查询状态、证据索引和摘要 | session-state 可重建投影，关联原生日志引用和领域事件 ID |
| project/conversation metadata | workspace store |
| 模型配置、role 映射 | agent-runtime；密钥继续使用既有凭据机制 |

建立 session/event 引用解析器，确保证据查询可以取回工具结果而不复制完整对话。外部 UI/MCP 独立上报的事件可能没有原生工具记录，保存在领域 journal；Harness 发起的 tool/call、tool/result 继续使用原生记录。

迁移前保存一致性备份，暂停新写入并停止进行中的运行。对现有 events、session-state journal、plan.execution_context 逐项核对，按来源 ID 合并历史证据，保留无法对应到原生日志的内容。写入版本标识和映射表，再核对会话数、workflow、证据、cursor、审批及子计划位置。迁移失败中止，不能清空状态或自动重新执行硬件调用。

投影缺失可以重建；投影损坏不能被当成“没有 workflow”。进行中但结果未知的工具调用恢复为待核实，不自动重放。

## 6. 开关行为与能力发现

新增能力查询（建议 `GET /api/edmore/capabilities`），返回能力 ID、提供者、enabled/disabled/blocked/failed 状态、依赖与具体原因。这个列表来自实际服务注册及生命周期状态，不能只读配置文件。

| 操作 | 系统行为 |
|---|---|
| 关闭 WebUI | agent、workflow 和其他客户端继续运行 |
| 关闭 Session State 查看/导出 | 关闭 client-api 对应视图接口；证据投影继续供 workflow 使用 |
| 关闭 session-state 核心（开发配置） | 依赖预检要求同时停用 Workflow；普通用户通过 Workflow 整组开关管理 |
| 关闭 plan-judge | 普通聊天可用；需要工作流授权的工具操作明确拒绝 |
| 关闭 MCP bridge | 聊天、已有计划/记录查看可用；相关 executor role 不再可调度 |
| 关闭 workspace | 项目索引及自动标题不可用；可显式使用 Harness session 创建/恢复接口 |
| 关闭标题插件 | 聊天、工作流及手动改名可用 |
| 关闭 HTTP API/webServer | 当前 WebUI/NionSwift HTTP 客户端断开；具备非 HTTP 适配器的客户端仍可使用服务 |
| 关闭持久化或授权基础服务 | 停用依赖它的执行能力；不切到内存/无审批模式 |

对只想隐藏状态页的用户，提供单独的“状态查看”开关，名称应区别于“工作流证据服务”。允许基础服务与业务功能分组，但不让基础依赖开关伪装成普通页面开关。

## 7. 插件管理、错误处理与生命周期

桌面管理器先计算依赖闭包，展示停用的相关能力，生成完整一致的配置组合，再进行隔离预检。可选业务模块未启用时，组合层不挂载其消费者；不能留下 Cordis 永远等不到的必需 inject。

能力不可用时 API 返回结构化错误，如 capability_unavailable、provider、missing_dependencies；不得返回虚假成功。WebUI 先读取能力，再分别加载视图；单个视图失败不阻断聊天初始化。

错误隔离覆盖插件实际启动：基础服务失败按错误退出；可选插件启动失败由组合加载层记录为 failed，完成部分资源释放后隔离其依赖模块。先用当前 Cordis Loader 的真实加载组合验证这一行为；若当前 boot 对可选错误仍整体退出，则由 EDMORE 组合插件管理可选子树并传播必要错误，不修改原生 boot 去吞掉所有异常。

第一版开关通过受控重启生效。执行期间先停止接收新任务，等待或取消当前运行、保存状态、flush，然后 dispose 订阅、timer、路由、工具和 agent。取消不等于硬件动作已经撤销；结果不确定时保留待核实状态。核心实现中现有 fire-and-forget dispose 应改为可等待的退出流程。

## 8. 实施顺序与每步验收

1. 固定现状测试并定义 Core-only 验收：现有完整 profile、普通聊天、MCP 发现、approval、skill 确认、报错暂停、多层 subplan、重启恢复；记录 ID 和工具次数。Core-only 必须能启动、管理模型、创建/恢复 session、聊天、读取 skill、取消任务、查询能力；无凭据时管理入口仍可用，不发起模型调用。
2. 建立 contracts、能力登记和依赖预检：桌面关闭 session-state 时明确显示影响，生成的 profile 不因缺失业务 inject 整体失败。
3. 提取 events：统一 receipt、cursor、持久化与订阅生命周期；证明重连不重放命令，消费者异常不污染 journal 写入结果。
4. 提取 agent-runtime：移除对 workflow 的直接引用；无 plan-judge 的聊天组合能够运行并恢复原生 session。
5. 分离 MCP bridge 与 tool-policy：保留底层安全检查；无 plan-judge 时不能执行受控工具，普通 MCP 发现独立工作。
6. 拆 session-state 与 HTTP：迁移证据并建立单一来源；关闭状态视图，workflow 证据包和子计划结果仍完整。
7. 重装 plan-judge：插件自行拥有 workflow 实例，依赖抽象服务；取消 backend 工厂和双向 bind，保证一步只推进一次。
8. 分离 workspace、title、client-api 和 WebUI：按能力装配；所有现有 HTTP/SSE 路径继续由新的唯一实现提供，无旧实现兼容层。
9. 更新 Core bundle、profile 和桌面管理器：Core 必选，Workflow 成组开关，其他功能按依赖启用；删除旧 backend 装配、重复 Context 类型和旧 fallback；更新锁文件、插件列表与帮助说明。
10. 组合验收及真实环境验收：先模拟工具和模型，再连接真实 NionSwift；不因测试自动执行未经批准的采集。

每阶段使用当前 `EDMORE/client` 的真实 profile/Loader 启动测试，不能只 new 类验证。验收后记录完成项和剩余问题，再进入下一阶段。

## 9. 最终验收矩阵

- 全功能、无标题、无状态视图、无 workspace、无 MCP、无 workflow、无 WebUI，以及缺失 workflow 证据依赖。
- 注入单个可选插件启动错误、运行中订阅错误、日志写入失败和 MCP 断线，验证实际影响范围与错误提示。
- 关闭/启用多次、进程重启、WebUI 与 NionSwift 同时订阅，检查 listener/timer/route/tool 是否泄漏。
- 多层 subplan 返回、原有确认归属、重复点击去重、跨 conversation 仪器占用和模型按 role 生效。
- 对比迁移前后的原生 session ID、领域 event ID、cursor、证据 digest、待批准计划与恢复步骤。
- 验证 skill 明确确认和实际报错仍能暂停；关闭插件不能绕过这些约束。

完成标准：删除旧 backend 巨型装配；业务插件不导入其他插件的具体存储类；公共依赖图无双向调用；关闭可选功能不导致无关服务启动失败；所有受影响能力及原因均可查询；原生 Harness loop 与数据恢复能力保持可用。

## 10. 功能保持约束与交付状态

本次是内部模块归属和依赖关系的重构。全功能组合下，现有用户操作、模型选择、skill 读取、MCP 工具调用、plan/judge、批准与确认、子计划返回、会话恢复、项目管理和前端订阅应保持行为一致。明确允许的变化是可选功能关闭或失败时，无关功能继续可用，并显示准确的能力状态。

Core 的内部模块统一命名为 Runtime、Models、Sessions、Events、Skills、Registry、Tasks、Policy、Diagnostics。它们是同一必选 bundle 的内部所有权划分，不是九个用户开关。HTTP/SSE 与 WebUI 为外部适配；workflow 的执行证据、计划状态和子计划栈由 Workflow 功能包拥有。

实施前固定全功能基线及其测试结果；每次只提取一个可验证的模块，检查接口、数据、工具调用次数和顺序，再继续下一项。现有 HTTP/SSE 路径、事件字段、session ID、项目和聊天记录保持可用。存储迁移须单独验证并保存迁移前备份，不以重新创建会话代替恢复。

每阶段同时验证全功能组合和相关的禁用组合。模块验收后移除对应旧实现，不保留两套 active orchestration、旧实现兼容层或 fallback。保留现有公共接口由新模块实现，不等于保留旧实现。

发现现有缺陷时单独记录原因、修复范围和行为差异，不混入重构中无说明地修改。不承诺未经验证的零回归；完成声明应列出已执行的验收及尚未覆盖的真实环境路径。

当前交付状态：主要代码拆分已完成。Core 统一初始化原生运行接入、模型/角色、任务、事件、策略与能力服务；workflow、MCP、workspace、HTTP 和 WebUI 各自装配。证据迁移及模拟验收通过，在线旧后端尚未切换，不将模拟结果表述为真实硬件验收。下方的早期批次记录反映当时状态，以最新进度表及最后批次为准。

## 11. 实施记录

### 阶段 1：当前行为基线（2026-09-16）

- 已检查当前工作树；本轮在已有未提交的 skill、确认、Session State 和桌面改动基础上继续，不覆盖它们。
- `client: npm test`：10 个测试文件、67 项测试通过。
- `desktop: npm test`：15 项测试通过。
- `client: npm run test:smoke`：真实 profile/Loader 启动、离线 MCP、skills、WebUI、session-state 查询/导出/replay、conversation 持久化、重启和退出通过。
- 测试使用临时 DSH_HOME、独立端口、离线 MCP，没有请求模型或操作当前仪器。
- 局限：上述测试不是所有真实模型与硬件路径的完整基线；真实 NionSwift 端到端验收仍在最终阶段。

### 第一批：依赖基础与独立状态查看（2026-09-16）

对应实施步骤 2、3、6 的部分工作；不是这三个步骤的全部完成。

重构内容：

- 新增 `client/packages/contracts`，统一领域事件与过滤器类型。
- 新增 `client/packages/core`，接管唯一的 EventHub 和 ActionRegistry；backend 改为注入服务，不再创建另一份实现。保留原事件字段、日志路径和动作去重记录。
- Core 增加初步能力登记，backend 提供 `/api/edmore/capabilities`。当前状态仅表达服务 ready/unavailable；完整 failed 生命周期、原生依赖诊断留待后续。
- 桌面插件管理增加必选 Core 和依赖预检，拒绝生成缺少必需依赖的开关组合。尚未实现 Workflow 整组开关或自动计算停用闭包。
- `session-state` 只负责状态/证据服务，自己订阅和回放 Core 事件；删除 backend 的重复订阅入口。
- 新增 `session-state-api`，独立拥有原查询、导出、事件和 SSE 路由。关闭它只关闭状态查看 API，不关闭 workflow 的证据存储。
- WebUI 按能力隐藏不可用的 Session State 页；初始化请求分别处理失败，能力查询失败不再阻断其他初始化请求。
- 更新 profile、依赖与锁文件；没有修改 `client/runtime` 的 Harness 实现，没有新增备用 agent loop 或旧实现兼容层。

验证结果：

- 支持版本 Node v24.19.0 下：client 11 个测试文件、70 项测试通过；desktop 16 项测试通过。
- 新增事件持久化/replay/filter、取消订阅、动作重启去重及 custom action 安全测试。
- 真实 profile/Loader smoke 通过：完整组合启动、离线 MCP、skills、UI、状态查询/导出/replay、conversation 持久化、重启、退出。
- 新增禁用 `session-state-api` 的真实启动组合：状态查看路由返回 404，能力接口报告 unavailable，证据服务、plan-judge 和 UI API 仍可用。
- Playwright 验证状态页能力开关、conversation/state 切换、工作流占用/取消、恢复选项，以及桌面/手机视口，通过；未调用实时 API。
- `test:portable` 在独立目录安装依赖并运行扩展 smoke 通过。该项最初使用 Node 23 执行，有 engine 警告；上述单元、浏览器与真实 profile smoke 随后使用支持的 Node 24 复验通过。
- 所有后端测试使用临时目录和隔离端口，没有调用模型或真实硬件，没有重启 7380 上用户正在使用的后端。

已知边界与下一批：

- Core 目前只拥有 Events/actions 和初步能力服务，不是九模块完整 Core；backend 仍硬依赖 plan-judge 和证据服务，不能声称关闭 workflow 后已能独立聊天。
- EventHub 仍沿用原持久化策略；写入失败原子性、消费者异常隔离及 evidence 单一 journal 来源尚待完成。
- 下一批先完成步骤 3 的事件可靠性验收，再按步骤 4 提取原生 agent-runtime 接入，移除对具体 workflow 的依赖；随后分离 MCP/policy。
- 模型、session、任务、工具策略、workflow 自主装配、其余 API/UI 边界及完整开关矩阵仍未完成。
- 桌面改动目前在源码中，已安装 EDMORE.app 尚未重新打包；在线后端也尚未加载本批代码。

### 实施进度表

| 步骤 | 当前状态 | 剩余验收 |
| --- | --- | --- |
| 1 基线 | 自动化基线及 Core-only 本地模型验收完成 | 真实模型/硬件对照 |
| 2 contracts/依赖 | 公共契约、依赖闭包、可选失败隔离已实现并测试 | 实际安装环境切换 |
| 3 events | 提取、写入隔离、去重/请求指纹、失败回执及损坏日志阻断完成 | 大日志性能为已知限制；人工恢复须核实硬件 |
| 4 agent-runtime | Core 内部运行模块完成，无 workflow 原生聊天及 session 恢复通过 | 真实 provider 验收 |
| 5 MCP/policy | 可选 bridge 与 Core policy 分开，模拟发现/调用/拒绝/断线清理通过 | 真实 NionSwift 工具链 |
| 6 state/HTTP | 存储与 API 分开，Core 引用及旧 plan 证据迁移测试通过 | 在线数据迁移和对照 |
| 7 plan-judge | 插件自主创建/恢复实例，构造注入调度/证据，删除旧证据 fallback | 真实多 agent/workflow 验收 |
| 8 API/UI/workspace | HTTP、WebUI、workspace 存储/API、标题独立，能力适配完成 | 在线 NionSwift 订阅回归 |
| 9 Core/profile/desktop | 必选 Core、可选插件生命周期、依赖预览/联动完成，Mac 打包成功 | 安装新控制器；Windows 实机未测 |
| 10 全链路验收 | 单元、本地模型原生 loop、重启、取消、禁用/失败组合及便携安装通过 | 在线重启及真实 NionSwift/硬件验收尚未完成 |

### 第二批：事件提交与消费者隔离（2026-09-16）

对应步骤 3 的可靠性部分，尚不代表步骤 3 全部完成。

- 原先先修改内存/cursor 再写盘，改为串行生成候选事件、写同目录临时文件、rename 提交成功后再更新内存和广播。文件写入失败不会发布事件，也不会推进 cursor。
- 单次写入失败向 append 调用方报告，但不污染后续写入队列；flush 等待队列排空，不重复抛出已经由 append 报告的失败。
- 同步抛错或异步拒绝的订阅者单独记录错误，不改变成功提交结果，也不阻止其他订阅者接收事件。
- 查询、订阅与 append 返回独立副本，防止消费者修改日志中的内存事件。
- 保留事件字段、日志路径和 JSONL 格式，没有修改 Harness runtime、workflow 审批或 agent loop。

验收：支持的 Node 24 下 client 11 文件、72 项测试通过。新增真实文件系统写入失败及恢复测试、并发 cursor 顺序测试、同步/异步消费者异常隔离测试；真实 profile smoke（包含关闭状态查看插件的组合）通过。未重启在线后端，未调用模型或硬件。

边界：当前仍为整份 JSONL 临时文件替换，未优化为追加日志；未声明断电 fsync 持久性。损坏旧日志处理、完整 receipt/消费确认、证据单一来源仍需继续验证。下阶段完成这些事件约束后进入 agent-runtime 解耦。

### 第三批：重启去重与日志完整性（2026-09-16）

- ActionRegistry 先等待日志加载完成，再读取动作 receipt，避免刚启动时尚未加载历史便重复执行。
- 同一 action ID 的历史记录及运行中请求必须匹配 action 和 session；跨会话或跨动作碰撞明确拒绝，匹配的并发请求共享同一次执行。
- 重启前仅 accepted、无结果的动作继续保持“结果未知”，不自动重放。
- 损坏日志不再跳过：校验必要 envelope 字段、时间、ID 唯一性及 cursor 严格递增，报出文件和行号并阻止加载。保留原文件，不自动截断或猜测修复，防止丢失动作 receipt 后重复执行。
- 避免对全部历史 cursor 使用展开参数求最大值，改用已验证有序日志的最后 cursor。

结果：Node 24 下 11 文件、75 项测试通过；真实 profile smoke（完整组合、关闭状态查看、重启和退出）通过。新增损坏日志不执行动作、未完成 receipt 重启阻断、并发去重和身份碰撞测试。没有调用真实模型或硬件，没有重启在线后端。

剩余：这不是完整事件事务系统。执行已成功但结果 receipt 写入失败的语义、人工修复日志流程、请求 payload 指纹和日志性能仍需单独落实；本批只校验 action/session 身份，不宣称验证了整个请求内容。agent-runtime 与 workflow 的提取尚未开始。

### 第四批：执行结果与回执错误分离（2026-09-16）

- 将 execute 和 completed receipt 写入拆成独立异常处理。动作返回成功但完成记录写入失败，不再错误生成 action.failed；明确提示结果需核实，保留已持久化的 accepted 状态。
- 执行抛错且 failed receipt 也无法写入时，用 AggregateError 保留两个原始错误，明确禁止自动重试；不把记录失败覆盖成单一工具错误。
- 相同 action ID 后续请求、重启后的请求均由 accepted 未决状态阻断，不重复执行。不保证外部硬件 exactly-once，也不推断抛错意味着硬件没有发生动作。
- 新增成功后完成回执失败、执行错误与失败回执同时失败两类注入测试，检查实际 execute 次数始终为 1。

验收：Node 24，11 文件、77 项测试通过；真实 profile smoke 启动、状态查看禁用组合、持久化恢复、重启和退出通过。没有修改原生 Harness，没有操作在线后端或硬件。

第 4 步入口已检查：backend 的 agent adapter 仍直接调用 workflow.nextLoopDispatch 和 bindHarnessSession；MCP tool bridge 仍直接调用 beforeLoopToolCall/afterLoopToolResult/handleLoopToolError。下一阶段必须分别建立运行调度扩展与工具策略契约，不能简单把 workflow 改成可空而放开受控工具。本批未声称已解除这些依赖。

### 第五批：原生 loop 接入层的调度契约（2026-09-16）

进入第 4 步，当前仅完成调度边界，不是整个运行层独立。

- contracts 新增 RuntimeScheduler/RuntimeDispatch，Core 提供 edmoreScheduling 服务。注册只有一个明确所有者，重复注册报错；注销可重复调用，不误删后续注册。
- EdmoreAgentLoopBridge 不再持有具体 EdmoreWorkflow 实例，改用调度服务关联会话和取得下一次 dispatch。仍由 Harness 原生 session/agent 执行，不引入备用 loop。
- 原 workflow 的子计划到父计划调度选择保留在注册提供者中，dispatch 的 workflow ID、角色、prompt 和步骤字段原样传递。
- 普通会话关联可以没有调度提供者；明确携带 workflow 的后续执行在提供者不存在时拒绝，提供者错误直接传播，不转普通聊天执行。
- 注册暂由 backend 组合层完成，并通过 Cordis effect 注销；最终由 plan-judge 自主注册是后续工作。
- MCP 工具审批钩子完全保留，backend 对 plan-judge 的必需依赖尚未移除，不能声称 Core-only 聊天已可用。

验收：Node 24 下 12 文件、80 项测试通过，真实 profile 完整启动/禁用状态查看/恢复/退出 smoke 通过。新增调度身份传递、错误传播、无提供者拒绝和注册释放测试。没有调用模型或硬件，也未重启在线后端。

下一项：迁移 role runner 公共契约与运行层装配；之后让 workflow 自主拥有实例并注册调度/策略，完成关闭 workflow 的真实组合测试。完整 Core-only 验收仍待完成。

### 第六批：Workflow 自主装配和 HTTP 分离（2026-09-16，已完成本批拆分）

- plan-judge 自行创建、恢复并持有 workflow，删除 backend createWorkflow 工厂；workflow 插件自行注册调度和工具策略。现有 bindRoleRunner 目前仅在插件内部注入，运行层不再反向绑定。
- Core 新增 ToolPolicyRegistry；无策略时受控 MCP 调用直接拒绝，MCP 发现不需要 workflow 实例。
- 新增 runtime 包，接管模型、角色、原生 loop 适配和外部触发路由；backend 改为 HTTP/UI 适配，不再拥有运行类。运行服务内部还有进一步划分工作，不能把文件拆分等同全部完成。
- 移动通用 MCP 内容转换和 RoleRunOptions 到 contracts；事件类型不再由 plan-judge 重复定义。
- plan-judge 的 skillsRoot/statePath/autoRepairMaxAttempts 配置归到该插件，移除 runtime 中对应闲置配置。
- 退出处理改为等待工具、agent 的 dispose 和事件 flush。

已验证：81 项单元测试通过；真实 profile 的完整组合、无状态查看，以及同时关闭 workflow/证据服务的组合启动通过。无 workflow 时 UI、skills、模型设置接口可用，approval 请求拒绝。

后续本地模型原生 loop、重启上下文及包依赖清理结果见第七至九批。没有重启用户在线后端或调用仪器。

### 第七批：必选 Core 与独立功能插件（2026-09-16）

- Core 统一初始化 runtime 内部模块；没有提供额外的 runtime 用户开关。使用原生 agent/session/session-persistence，未修改 client/runtime。
- 新增独立 mcp-bridge，拥有 MCP 连接、轮询、注册工具和注销生命周期；Core 只保留连接注册契约与策略入口。断线清理过期工具；发现不要求 workflow，执行要求已注册策略。
- backend 现在只拥有 HTTP 命令、查询与 SSE；新增 webui，网页资产从 backend/static 移到 webui/static，没有复制旧页面或保留旧实现。
- workspace 的存储和 HTTP 拆成 workspace/workspace-api。标题仅依赖 Core 与 workspace，不依赖网页或 HTTP。
- 新增 optional-feature 生命周期包装：依赖未就绪时阻塞对应子插件；启动失败记录 failed/error，并由 Cordis 清理部分资源，不让业务插件失败关闭 Core。不修改原生 Loader，也不吞掉 Core 基础服务失败。
- 桌面开关计算依赖闭包，预览受影响插件后确认；必选 Core 及其依赖不能被间接关闭。保存配置前做预检，防止把无效状态先写入文件。
- WebUI 根据能力启用项目和状态视图；workspace 不可用时仍启动当前会话的订阅，启动期间会刷新能力。

验收：关闭 workflow/证据、MCP、workspace、title、WebUI 和 HTTP 适配器的组合均进行真实 Loader 启动验证；注入可选 WebUI 启动异常后，failed 状态可查询、临时路由不泄漏，原生聊天继续工作。测试使用独立端口及临时数据目录。

### 第八批：证据唯一来源与任务收口（2026-09-16）

- session-state 中与 Core 事件完全一致的记录改为 event_id + SHA-256 引用，内容由 Core 日志解析；工作流独有的证据继续由 workflow evidence 存储拥有。
- 旧证据日志迁移前生成 events.before-core-refs-*.jsonl 备份；引用缺失或校验失败会阻断证据加载。迁移前后 version、事件 ID 与 evidence digest 测试一致。
- 删除 plan.execution_context 的运行时 fallback。缺少证据服务时执行拒绝；旧计划证据只通过 migrateLegacyEvidence 一次迁入证据存储，flush 后备份计划文件，再删除计划内旧记录并保存。
- workflow 的 role runner 和证据改为构造注入；backend 的 createWorkflow 工厂和反向 bind 不再存在于运行装配。业务代码依赖 WorkflowControl、WorkflowEvidence 和调度/策略契约。
- 动作请求增加规范化请求内容指纹；同一个 action ID 但内容不同或无法核实的请求拒绝，不只比较 action/session。
- Core Tasks 统一排队与取消；取消透传原生 agent，排队任务不再执行，新的后续请求仍可用。新增 POST /api/edmore/actions/cancel，明确返回 hardware_stop_verified=false。
- 能力缺失的 HTTP 操作返回 503、capability_unavailable 和 capability 标识。

验收：87 项测试通过，包括真实临时证据存储、备份/迁移/重启、缺失证据拒绝、MCP 策略顺序、取消排队及请求指纹。用本地 OpenAI-compatible 模拟服务验证原生 loop 真实发起请求和回复；后端重启前后 session ID 相同，模型请求包含上一轮上下文；原生取消后排队请求未发送，下一条新 query 正常。

### 第九批：综合验收与交付边界（2026-09-16）

- client：16 个测试文件、87 项测试通过（Node v24.19.0）。
- desktop：17 项测试通过；依赖联动及必选 Core 保护通过。
- Playwright：工作流占用/取消、恢复选项、Conversation/Session State、能力开关、桌面和手机视口通过。
- portable：独立目录 npm 安装与扩展真实 profile smoke 通过，不依赖 SEM 工作目录外的旧 Harness checkout。
- 额外无 HTTP 组合：关闭原生 webserver 和所有 HTTP 适配器后，Core 与 workspace 元数据服务加载通过；测试探针按可选服务生命周期订阅，而非把可选服务当作顶层必需 inject。
- macOS arm64 控制器已成功打包到 desktop/release/EDMORE-0.3.0-arm64.dmg；尚未替换正在运行的安装版。构建为本地 ad-hoc 签名，未公证，Windows 未进行实机验收。
- git diff --check 通过；client/runtime 没有本轮修改。
- 7380 的旧进程仍由已安装 EDMORE.app 管理。只读检查发现两个 active workflow，其中一个 paused 且仍持有暂停仪器占用；未替用户终止、批准或重启这些任务，已询问是否允许切换。

未完成的最终验收：部署到在线后端、检查真实数据迁移备份、NionSwift 同会话订阅与真实模型/工具/多层子计划完整回归。新 WebUI 文件路径已改变，旧进程刷新网页可能找不到资源，需在安全时重启加载新 profile。不能据自动化结果宣称已完成真实硬件验收。

已知运行限制：Core event journal 仍整文件原子替换，未优化大日志写入性能，未声称断电 fsync 或跨进程同时写入安全。损坏日志停止加载，人工恢复必须保留原文件、比对备份/引用/未决动作，不能删除 accepted receipt 来强制重跑硬件。

### 2026-09-16: Judge / intent context overflow repair

### 2026-09-16: Cancel paused parent/child chain

### 2026-09-16: Empty project UI

### 2026-09-16: Workspace layout and conversation model

2026-09-16 MCP model connection: bridge reads advertised model://, reasoning:// and optional provider:// resources with a 30-second metadata cache. Ordinary MCP servers without those resources remain usable. Executor model priority is explicit per-agent setting, then MCP model, then conversation model. Reset in Settings removes the manual provider/model but retains other role limits. A model-only MCP resource must uniquely match a configured provider profile; ambiguity fails with a settings instruction instead of sending the model to an arbitrary endpoint. Live read-only discovery found all four NionSwift agents advertise llm3. No hardware calls or model requests were made. Unit suite (95 tests) and browser smoke passed before provider matching refinement; online backend still needs restart.

Model policy correction: the conversation selection now applies to every role, including isolated intent/planner/judge calls, title generation and executors without an MCP model. An explicit MCP model is retained, together with its provider when supplied. This supersedes the main-conversation-only policy below. Role-specific output limits/timeouts are unchanged; selection applies on the next call and does not interrupt an active call. Regression covers isolated roles, unpinned/pinned executors, persisted selection, other conversations and role overrides.

- WebUI and Electron Workspace share /edmore: projects/conversations left, conversation/composer center, plan and its actions right. Providers, MCP occupancy, tools, agent model configuration, skills, events and session-state inspection are in a modal settings view.
- Composer model selection uses configured provider/model profiles. GET/POST /api/edmore/conversation-model stores a session-scoped override in the role configuration store and reports effective selection. Reset removes the override. Isolated intent/planner/judge and executor roles are unchanged.
- Selection is read on the next native conversation call; it does not cancel the current call. Removed a stale existing.chain reference from native agent reconfiguration; native session persistence remains responsible for restoring the same conversation.
- Unit coverage: 94 tests passed including model isolation, reset and persistence. Isolated backend smoke verifies HTTP selection and restart persistence, native sessions/cancellation and optional plugin combinations. Browser smoke verifies plan-only sidebar, scoped model POST, settings, occupancy, empty-project deletion and desktop/mobile layouts. Screenshots inspected; no real model/hardware calls performed.
- App Workspace needs no separate frontend build because it loads the shared web page. Online backend was not restarted; the new model endpoint requires restarting the backend, then reloading WebUI/App Workspace.

- Removed WebUI automatic conversation creation when loading an empty project or deleting its last conversation. Empty selection clears the previous chat/plan and closes its conversation stream.
- New records are created only by New conversation or the first submitted message in a selected project. Deleting the last project clears selection; sending without a selected project requests project selection.
- Browser regression deletes the final conversation, reloads the empty project, then deletes the project, asserting zero automatic POST requests. Desktop/mobile UI smoke passed. Local project folders and runtime workflow state are untouched.

- Live inspection: SEM lease referenced parent 444c7e15 while the paused session held child 430601ad. The cancel endpoint matched only the current child's ID, rejecting the parent shown by the occupancy UI.
- Cancellation now validates the selected ID against the paused chain in the specified conversation, cancels the child and suspended ancestors (including a pending linked child), releases their leases, and emits cancellation events for each plan. No parent is resumed. Unrelated IDs, cross-session requests, in-flight calls and missing hardware-stop verification remain rejected.
- WebUI confirmation explicitly describes whole-chain cancellation and refreshes state after a failed request. Regression covers parent-lease cancellation and existing safety checks. Online state is not edited and the backend is not restarted automatically.

#### Context overflow changes

#### 2026-09-16: Shared Planner/Judge input packet

- Both planner and semantic judge now use modelSkillPacket: one contract per skill_id and one copy of identical instruction text, referenced by IDs. Conflicting snapshots with the same skill_id fail closed instead of silently replacing authority.
- Primary skill, expanded order, execution allowlist, and supporting workflow identities are IDs. Supporting reference metadata retains reference-only authority and shares the instruction dictionary; no automatic authorization is added.
- Revision/review plan views omit skill snapshots, raw execution history, old judge reports, repair history and nested parent trees. Parent context supplies the blocked step, reason, confirmation observations and return rule. Existing bounded recent evidence and read-only evidence retrieval remain in use.
- Tests cover contract/text deduplication, conflicting snapshots, preserved optional-tool policy, and a recommendation planner fixture with a very large grandparent: 66177 bytes, without ancestor text. This fixture is not a measurement of the complete historical failed request or all possible model inputs.
- No intent routing changes, limit increases, native Harness runtime edits, hardware actions or online backend restart in this step.

- Observed OpenAI CONTEXT_WINDOW_EXCEEDED in both pending-plan intent classification and semantic review. The former hid the exception as wait; the latter incorrectly retained deterministic pass with a warning.
- One-shot planner/orchestrator/judge calls now use fresh native Harness sessions. Ordinary conversation/executor sessions remain persistent. No replacement agent loop or keyword fallback was introduced.
- Pending intent receives plan identity, goal, summary and status instead of the entire plan/evidence tree. Classification errors are surfaced without changing the pending plan.
- Semantic review omits duplicated step snapshots, historical repair messages and the nested parent plan. Pinned authority remains supplied separately. Non-executor evidence covers the current and immediate parent workflow; older evidence is available on demand.
- Recent evidence is capped at 30 events / 16000 characters and projected workflow state shares a 12000-character budget. One-shot input has an additional 96000 UTF-8 byte guard (not an exact model token count). Oversized mandatory material stops the decision rather than silently truncating safety constraints.
- Session-scoped read-only edmore_read_evidence lists 30 references per page and retrieves exact JSON in 12000-character pages. It cannot read a different conversation or invoke hardware. Original journals remain intact.
- Semantic review errors block approval. Previously persisted plans containing the failed-judge warning are also rejected by approval and require a new review.
- Regression tests cover failed semantic review, compact intent input/error propagation, evidence limits, exact paging and conversation isolation. Smoke coverage includes two independent native review sessions with the evidence service enabled, using a local fake model only.
- Online backend was not restarted, existing workflow locks/plans were not changed, and real OpenAI/hardware execution was not invoked. This remains an online acceptance task after restart.
