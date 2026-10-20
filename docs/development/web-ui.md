# Platform Web 基础组件

UI 选型以[工程 Spec §2.1](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#21-技术栈)为准。
本次迁移对应 [#389](https://github.com/AgoraIO-Extensions/agent-infra/issues/389)，不增加产品能力。

## OpenDesign 视觉版本

[#1208](https://github.com/AgoraIO-Extensions/agent-infra/issues/1208) 对整体 Web 采用新的 OpenDesign
设计，保留工作区、我的管理、系统管理的职责分组和现有服务端契约。原 #400 原型保留。
设计项目为 `agent-infra-web-redesign-1208`，对话为 `ab988058-7eb4-4da7-98dc-0d07bdc88c8e`。
在 OpenDesign 中打开该项目的 `index.html` 可交互预览；`DESIGN.md` 定义视觉规则，
`IMPLEMENTATION.md` 映射现有页面。`DESIGN-MANIFEST.json` 指定 `index.html` 为唯一 canonical，
`login.html` 为登录页支持稿，`index-v2.html` 仅作历史参考、不参与验收。落地版本的 SHA-256 为：

| 文件 | SHA-256 |
| --- | --- |
| `index.html` | `b540e4c948bd506fc33623f506a1d2b472c26a1fe8bf362b83b0165cbe1ecd26` |
| `login.html` | `6e04830eb0aac86e7ffea6dc6f3db0faab7942e2379c6230efe0512519d0c0a7` |
| `DESIGN.md` | `162e8fb0c381cb96da71a0f838c8ce80b7076ebb6b08071cc2845961e481da18` |
| `IMPLEMENTATION.md` | `3ee03b85afb5567576ff2ac64c1459b811490591d52e16c048809d173bc75a3b` |
| `DESIGN-HANDOFF.md` | `3f2313d6d72bf3d7263d1e864730278217836ccdd5730d4b83460518bd2d3396` |
| `DESIGN-MANIFEST.json` | `2846fe1e5da4c43a0b8407b635b6591b9fd1ac750b4427e862b7bfd68787ea97` |

`src/index.css` 将暖灰背景、石墨文字、蓝色主操作、状态色、10px 控件圆角和 14px 面板圆角
映射到现有 shadcn 变量，并提供设计同名别名（`--bg`、`--fg`、`--surface-raised`、`--accent`、
`--accent-soft`、`--danger`、`--shadow`、`--font-body`、`--font-mono`）与 ink 色
（`--accent-ink`、`--success-ink`、`--warning-ink`、`--danger-ink`、`--muted-ink`）。
设计 `--muted` 是文字色，对应 `--muted-foreground`。主按钮、eyebrow、占位符和帮助文字使用 ink 色；
等宽文字只引用 `var(--font-mono)` 或 Tailwind `font-mono`。
页面共享内容宽度、标题和表单样式；桌面侧栏为 248px，
低于 1024px 使用现有 Sheet。工作台先展示最近对话和职责事项，再展示 Agent 与申请。
Agent 详情中的 Owner、渠道、模型和范围均取自实际投影；Owner 配置入口仍由权限结果控制。
详情页读取带 Owner 有效状态的详情投影（[工程 Spec §9.1](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#91-identityadapter)），
侧栏 Owner 行的 chip 只映射服务端状态：有效（green）、已禁用（amber）、已离职（gray）、状态未知（gray），
不区分主要与共同 Owner；服务端没有返回名称时先取目录名称，再只显示「用户」与 ID 短形式。
「运行与渠道」的企微行只显示服务端投影的真实绑定状态（[工程 Spec §14.2.2](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1422-传输与执行)），
不显示可见范围：已绑定（green）、绑定中（amber）、连接异常（red），不显示原始枚举。
Owner 配置页的企微机器人卡片读取带扫码能力的状态 V2（[工程 Spec §14.2.1](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1421-配置与凭证)）：
扫码不可用时点击「扫码授权」直接显示「扫码授权暂不可用」面板与「改用手动配置」，不建立配置会话；
能力未知时先重读状态，只有服务端确认可用才建立配置会话。
侧栏「我的 Connection」、对话「会话上下文」中的 Connection 提示与 Agent 详情「打开 Connection」
只由 `src/features/connection-entry.ts` 生成：先按服务端规则分别校验原始 `publicOrigin` 与
`mcpPath`，再拼接并确认 origin 不变。
对话时间线独立滚动，保留消息输入区及代码、表格的局部滚动。
短视口（高度不超过 600px）只压缩页头与间距，仍只有时间线一处滚动；执行详情是模态弹窗，关闭后焦点回到触发按钮。

原型中的示例人员、模型、就绪提示和演示操作不作为生产数据或新增能力。
申请、审批、配置、生命周期及审计继续复用现有组件、请求和权限校验。

### 与导出设计的已定差异

以下差异已在 #2862、#2863、#2903 确认，实现与验收以这里为准，等待设计稿回写：

| 位置 | 实现 | 依据 |
| --- | --- | --- |
| `Button` `size="sm"`（返回链接、卡片按钮） | 最小高度 44px，不采用 `.btn-sm` 的 38px | DESIGN.md 触达下限 |
| 顶栏 | 不展示「平台就绪」 | 平台健康属于运维入口（PRD §11.1） |
| 创建审批 | 没有「风险」筛选与列 | 审批看资源规格与准入（PRD §5.1、§6.2） |
| 审批列表、申请详情 | 不展示 `app-024` 式申请编号 | PRD 没有申请编号 |
| 浏览器卡终态 | 不提供「重新请求」 | PRD §11.4、§13.3 |
| Skill 发布范围 MEMBER | 文案为「全体成员」 | PRD §11.5 |
| 个人 API 凭证 | 不提供轮换；已撤销行只显示撤销时间 | PRD §7.3 |
| 对话标题 | 标题展示遵循 PRD | [PRD §12.2](../prd/PRD-agent-platform-M1.md#122-会话历史) |
| Builder、预览 | 不提供页面 | PRD §1、§5.7、§11.1 |
| Agent 的 Skill 绑定卡 | 增加「解除绑定」，确认后提交不含该项的完整集合 | #2903 AC-1、[工程 Spec §11.6](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#116-skill-hub版本绑定与-worker-装配) |

### 申请详情进度

[#2920](https://github.com/AgoraIO-Extensions/agent-infra/issues/2920) 已将 M-11 回写本版导出稿。
按 [PRD §6.3](../prd/PRD-agent-platform-M1.md#63-管理状态)，三步为「申请已提交 → 系统管理员审批 → 创建 Agent」；
资源与范围校验继续属于准入，不增加独立用户阶段。提交步骤始终显示「完成」（green），
审批与创建步骤按现有申请状态展示；两个视口均保持状态 chip 在步骤右侧。

| 申请状态 | 管理员审批 | 创建 Agent |
| --- | --- | --- |
| 待审批 | 等待（gray） | 等待（gray） |
| 已撤回 | 不再审批（gray） | 不再创建（gray） |
| 已驳回 | 已驳回（red） | 不再创建（gray） |
| 创建中 | 已通过（green） | 处理中（amber） |
| 可用、已停止 | 已通过（green） | 完成（green） |
| 创建失败 | 已通过（green） | 失败（red） |
| 已停用 | 已通过（green） | 已停用（gray） |

### 运维观测页

导出设计没有 `#ops`（F-12，设计回补见 #2863）。按 #2862 定论，`/ops` 保留在「系统管理」末尾
（[PRD §11.1](../prd/PRD-agent-platform-M1.md#111-页面)、[§14.2](../prd/PRD-agent-platform-M1.md#142-运维观测)）。
设计稿回写前以本节为这一页的设计依据，样式沿用同类管理页页头与设计 `#my-agents` 已创建卡，不另做原型。

- 页头：`.page-heading`，eyebrow「系统管理 / 运维观测」、h1「先确认平台状态，再定位故障。」
  （`tabIndex={-1}`，作为恢复焦点目标）与副标题。读取中和已读取时右侧有 44px ghost 图标按钮「刷新运维状态」，
  读取中禁用；其余状态不显示。
- 区块：已读取时依次为平台健康、Agent 与任务、依赖、告警四张 `Card`（`section`，以标题命名）。
  卡头对应设计 `.card-head`：h2 为 17px / 650 正文字体，状态 chip 在右，gap 14px；
  下方为 `dl.review-facts`，上距 15px。桌面两列、gap 16px；不超过 767px 时单列，事实列表上下排列。
- 状态 chip：`Badge` 显式传 `tone`，未接入为 gray、正常为 green、降级为 amber、不可用为 red。
- 事实：每块先列「覆盖」。数据只来自 `GET /api/v1/ops/observability`（`ObservabilityStatusProjectionV1`），
  该查询只报告 Platform API 观测采集与导出的独立健康信号（[工程 Spec §18.2](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#182-运行指标与故障)），
  显示在告警块：「告警出口」写「未接入」，并列出观测采集、采集失败、导出失败、丢弃日志、无效记录和最近导出失败时间（`Timestamp`）。
  任一计数大于 0 时告警 chip 为「降级」，否则为「未接入」。另外三块没有数据源，chip 和「数据来源」都写「未接入」。
  页面不生成指标、阈值或告警事实，也不为未接入的区块补零。

| 状态 | 条件 | 呈现 |
| --- | --- | --- |
| 未接入 | 查询成功，但区块没有数据源；或查询入口返回 404 | 区块按上文显示「未接入」；入口 404 时页头下为 `PageStateCard`（`unavailable`）「观测查询未接入」，没有操作 |
| 读取中 | 首次进入或刷新 | 页头下为 `LoadingLine`「正在读取观测状态…」，不显示区块 |
| 不可用 | 网络失败、503、其他失败状态、采集未启用或已关闭、响应不符合 strict 契约 | `PageStateCard`（`unavailable`）与「重新读取观测状态」；恢复后焦点移到 h1，仍失败时留在按钮上 |
| 无权限 | 会话没有 `system_admin`（不发出查询），或查询返回 403 | `PageStateCard`（`unauthorized`）「你没有访问运维观测的权限。」与「返回工作台」，不显示区块和观测事实 |

## 组件与调用方

`apps/web/components.json` 保持 `base-lyra`、`neutral`、CSS variables、`@/` aliases 和 lucide。
组件由 lockfile 中的 shadcn CLI 生成：

```bash
pnpm --filter @agent-infra/web exec shadcn add button input textarea native-select checkbox label badge tabs dialog sheet sidebar breadcrumb avatar alert empty table --yes
```

生成后将 `cn` 导入适配到既有 `@/lib/utils` alias，显式声明 Base UI、CVA、clsx、
tailwind-merge 与 lucide 依赖。主题变量在 `src/index.css`，按页面需要只定义实际使用的 token。
默认表单控件保留 44px 操作高度；输入文字、按钮换行和焦点环在基础组件中统一维护。

| 组件 | 实际调用方 |
| --- | --- |
| `Button` / `buttonVariants` | 申请创建、编辑、重新提交、撤回，审批，Owner 配置，生命周期，页面导航 |
| `Input` | 申请和 Owner 配置中的文本、密码字段 |
| `Textarea` | 申请、Owner 配置、多值字段、审批驳回原因 |
| `NativeSelect` / `NativeSelectOption` | 申请来源、身份责任；保留原生选择和禁用语义 |
| `Checkbox` | 申请和 Owner 的模型配置开关 |
| `Label` | 上述表单的可访问名称 |
| `Field` / `FieldError` | 字段标签与控件的容器；`FieldError` 为字段下方的校验错误（`role="alert"`），如审批驳回原因 |
| `Badge` | 状态 chip（`tone`，服务端状态经 `lib/status-tone.ts` 的 `statusTone()` 映射）与非状态标签（`variant="tag"`） |
| `Sidebar` / `Sheet` / `Breadcrumb` / `Avatar` | 桌面与移动导航、当前位置及登录身份 |
| `Tabs` | 我的申请与已创建 Agent 切换，Skill 详情的用途与版本 |
| `Dialog` / `ConfirmDialog` | 审批、Skill 审阅；撤回、生命周期、撤销凭证、撤销 Skill 版本、停用应用、禁用员工等确认 |
| `Alert` / `Empty` | 设计 notice（`tone` 与默认图标）与空态 |
| `Spinner` / `LoadingLine` | 读取中的加载态，`PageLoadingState` 内部使用 |
| `StateCard` / `PageStateCard` | 会话不可用、详情读取失败（401 / 403·404 / 503 / 响应无效）与 404 页的公共状态卡；401 的「重新登录」确认会话仍有效后调用 `onStillValid` 重读数据 |
| `Toast` | 根布局常驻的补充确认，页面通过 `useToast()` 调用 |
| `Card` / `AgentMark` | 独立卡片的悬停，Agent 标识的字形与 tone |
| `Table` | Agent 输出的 Markdown 表格，API 凭证页的个人凭证表格（窄屏按页面样式转行卡片） |
| `Timestamp` | 工作台、审批、审计、应用管理、个人 API 凭证、我的 Agent、申请详情、Skill 审核与对话历史的时间 |
| `IdentifierText` | 审批、Skill 审核与审计中未解析人员的 ID 短形式；审计列表对象 ID 同样用它的等宽短形式（`title` 为完整值），完整值在记录详情 |
| `Listbox` / `ListboxOption` | 目录选择器与审计 Agent 筛选的结果层、对话 `/` 命令弹层；候选不进入 Tab 序列，由输入框的 `aria-activedescendant` 导航 |
| `DropdownMenu` | 对话输入框工具栏的模型与思考菜单（`menuitemradio`，向上展开，无入场动画） |
| `Collapsible` / `CollapsibleTrigger` / `CollapsiblePanel` | 对话页「会话上下文」「会话文件」折叠条与回复卡「思考过程」（替代原生 `details/summary`）；面板默认 `keepMounted`，收起只隐藏不卸载 |

时间统一由 `src/lib/format-time.ts` 按浏览器本地时区与自然日格式化，`<Timestamp>` 渲染
`<time dateTime title>`，`title` 为带秒的完整本地时间。人员与组织显示名由
`src/features/directory-names.tsx` 的 `useDirectoryNames` 页面级批量读取：单元格和 chip 不放
`role="status"`，读取失败时页面只显示一条提示与「重新读取目录」，主文字不回退到内部 ID。
标准模板只显示部署配置登记的显示名：路由（或页面 workflow）用 `src/features/template-display-name.ts` 的
`useTemplateNameLookup()` 读取并传给页面，读不到时显示「标准模板」，不显示原始 `templateId`。
审计页读取带显示名的审计 V2 投影（[工程 Spec §18.3](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#183-持久审计)）：
对象列显示 Agent 或创建申请名称，Execution 等对象附所属 Agent 名称，应用主体显示「应用 · 名称」；
服务端没有返回名称时只显示类型与 ID 短形式，详情写「未提供」，不说明原因。
Agent 筛选沿用目录选择器的交互按名称单选，候选在展开时从个人可见或管理员 Agent 列表读取，提交的仍是 Agent ID。

`Card`、`Collapsible`、`ConfirmDialog`、`DropdownMenu`、`Spinner`、`StateCard`、`Toast` 与 `features/agent-mark.tsx` 为手写组件，不由 CLI 生成。
`Alert` 不设默认 role：首屏静态说明不设 role，异步结果用 `role="status"`，失败用 `role="alert"`。
`Badge` 只有 `variant="chip"`（状态，显式传 `tone`）与 `variant="tag"` 两种，不从 `data-status` 推导色调。
`Alert` 必须传 `tone`（`info`、`warn`、`danger`），没有旧变体名与缺省 tone 的兼容层。

普通导航保留 TanStack `Link` 或语义链接；需要控件外观时使用 `buttonVariants`，不改变链接角色。
站内路径一律用 `Link`（原生 `<a href="/...">` 会整页重新加载）；返回 / 取消链接的目标是当前地址的前缀时
加 `activeOptions={{ exact: true }}`，不让前缀匹配补上 `aria-current`。
读取失败后的「重新登录」「重新加载…」「重新读取」使用 `features/recovery-button.tsx` 的 `RecoveryButton`
（`PageStateCard` / `ReadFailureCard` 默认操作已内置）：请求中用 `aria-disabled` 保持可聚焦，失败后焦点留在按钮上；
恢复成功、按钮卸载后焦点移到页面 h1（需 `tabIndex={-1}`），没有可聚焦标题时落到 `#main-content`。
段落、列表、定义列表、表单和 fieldset 保持语义 HTML。
申请详情、Agent 详情和我的 Skill 使用索引路由，确保编辑、配置和创建子路径能渲染对应页面。

## 历史、身份与缺省状态

[#2925](https://github.com/AgoraIO-Extensions/agent-infra/issues/2925) 补充以下局部设计；原稿回写前以本节为依据。
行为范围沿用 [PRD 对话与历史](../prd/PRD-agent-platform-M1.md#112-对话能力)及
[Runtime HLD](../architecture/HLD-agent-runtime-M1.md#8-消息事件与-sse-可靠性)的现有契约，不增加领域状态。
下表未表示 canonical 已补画；外部原稿与最终摘要继续由 #2863 跟踪。

| 场景 | 呈现与交互 |
| --- | --- |
| 已完成回答的正文在更早记录（NW-15） | 仅在已完成、当前快照与增量均未加载该执行的任何事件且仍有更早记录时，显示 12px muted 状态行「已完成 · 正文在更早的记录中」和就地「加载更早内容」。加载中禁用重复操作，失败就地重试，成功后显示实际正文；失败、取消、处理中及没有更早页时不显示该提示。 |
| 同一消息的多个回答版本（CH-08） | 两版及以上时，在回答下方另起 12px muted 版本行，gap 4px、距正文 9px，排列上一版、版本 x/y、下一版；边界按钮禁用，沿公共 ghost 图标命中区。切换只改变所选回答及对应执行详情，不发送消息或生成新执行；窄屏保留全部操作。 |
| 详情读取 403/404（P-01） | 共用「无法访问」卡，说明资源不存在或无权访问，只提供返回上级，不重试、不区分对象是否存在。只有未知页面路由显示「无法打开此地址」。401、503、响应无效及恢复焦点沿公共状态卡规则。 |
| 首次确认会话（R4-02） | 保留侧栏、顶栏与内容起点的壳层骨架，导航占位不可交互、不显示访客或真实用户身份，正文用 LoadingLine 显示「正在确认登录状态…」。确认匿名后才切登录；暂时不可确认时保持骨架，显示不可用提示与「重新检查」，就绪后替换为真实身份及导航。 |
| 消息提交结果（G-04） | 结果未知时显示「提交结果尚未确认」与「核实原请求」，不自动重发，也不把网络错误当作未送达。仅确认未受理且 Agent 恢复可用后显示「消息未送达」，说明原文仍在输入框、可以重新发送；outline「重新发送」只在显式点击后用当前草稿提交。创建会话失败不使用消息丢失文案。 |
| Connection 引导（BR-04） | 有批准入口时显示「需要 Connection 授权」，引导到独立系统确认当前账号及具体 Action/版本授权，不断言当前用户尚未授权。本页点击后切换「等待 Connection 授权返回」，这是刷新会重置的本地引导态，不代表授权成功/失败。入口不可用时显示「Connection 暂不可用」且不给链接；Agent 无此能力时不显示提示。 |

### 返回链接与管理区布局

Owner 配置与申请详情沿公共管理页页头：页头文字区内的返回链接不额外追加窄屏 16px 上外边距，
其后 eyebrow 保持 9px 间距；16px 只用于换行后的页头操作。触达尺寸仍采用已定的 44px。
原稿回写时缩小宽泛 `.page-head .btn` 媒体规则的范围，不改变现有 Web 布局。

管理员 Agent 页（AA-01）依次排列页头、筛选、列表、分页、员工访问控制、应用凭证材料授权。
两个治理区在列表之后，以独立 FormSection 呈现，默认展开；标题采用 16px 正文字体，
说明、分隔线与控件沿公共分区规则。列表读取失败时只保留页头与失败提示，不展示治理区；
权限、pending、确认及结果反馈沿既有入口，不显示凭证材料值。
治理权限以 [PRD §2.3](../prd/PRD-agent-platform-M1.md#23-系统管理员)与
[PRD §7.3](../prd/PRD-agent-platform-M1.md#73-api-身份凭证与授权)为准。

## 静态规则

`pnpm check` 执行 `tests/support/web-ui-policy.mjs`，`pnpm test` 执行正负样例。
检查 `apps/web/src/routes` 和 `apps/web/src/features` 中的 TypeScript/JavaScript JSX，以及静态可识别的 `react` `createElement` 调用：

- 拒绝原生 `button/input/textarea/select/option/optgroup/label/summary`。
- 拒绝原生元素直接声明通用控件角色，如 `button/checkbox/combobox/textbox`。
- 拒绝业务页面直接导入 Base UI 原语，以及原生 `table`、`alert/dialog/tab/tablist/tabpanel` 替代组件。
- 同样拒绝词法绑定到 `react` default、namespace 或 named `createElement` alias 的上述字面量控件和角色调用，
  包括直接的一层 `const` 属性或解构 alias。
- 允许 `components/ui` 内部、普通语义内容 HTML、测试文件和三个具名现有测试 helper；生产页面不得导入测试 helper。组件选型遵守[工程 Spec §2.1](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#21-技术栈)。

规则检查直接 JSX 声明与静态可归因的 React 调用，包括一层不可变 alias；不会跟踪第二跳 alias，不是任意 JavaScript 数据流分析。不得增加业务文件级或目录通配排除。

`pnpm test` 还执行 `apps/web/src/lib/time-display-policy.test.ts`：页面不得直接调用
`toLocaleString`、`toLocaleDateString`、`toLocaleTimeString` 或 `Intl.DateTimeFormat` 显示时间。
该测试只允许格式化模块本身、生成代码与测试文件直接调用，不设页面白名单。

`apps/web/src/lib/internal-link-policy.test.ts` 扫描生产 TSX 中的原生 `<a>`：只允许测试里逐个列出原因的
非 SPA 目标（外链、Connection 入口、服务端登录入口、页内锚点、`useLinkProps` 生成的品牌链接），
其余站内跳转必须用路由 `Link`。

## 验证

```bash
pnpm --filter @agent-infra/web test
pnpm --filter @agent-infra/web exec playwright install chromium
pnpm --filter @agent-infra/web test:browser
```

浏览器测试运行实际生产构建，通过已有契约校验 Fake 拦截 API；不依赖真实凭证，不代表真实后端验收。
`auth.spec.ts` 与 `collection-session.spec.ts` 在 `auth-desktop` / `auth-mobile` project 中运行：
Playwright 另起一个配置了同源 `/auth/login`、`/auth/logout` 入口的构建（`dist/auth-browser`，
端口为 `WEB_TEST_PORT + 1000`，可用 `WEB_AUTH_TEST_PORT` 覆盖），其余用例使用未配置入口的默认构建。
桌面 1440×1000、移动 390×844 覆盖申请创建、编辑、重新提交、撤回，审批批准与驳回，
Owner 配置、Secret 清空、模型复选框、停止、重启、镜像升级，以及普通员工的权限负向场景。
同时检查 Tab/Enter/Space、必填校验、可访问名称、焦点环、结果焦点、pending 禁用、loading、
empty、error 和布局边界。

CI 保存 `web-management-<head SHA>` artifact，HTML 报告包含 head 元数据、旅程结果及截图。
PR 的人工 UI 验收仍遵循[工作流 §7.4](../architecture/SPEC-ai-native-development-workflow.md#74-人工验证)。
[#192](https://github.com/AgoraIO-Extensions/agent-infra/issues/192) 可复用这些基础组件；
[#194](https://github.com/AgoraIO-Extensions/agent-infra/issues/194) 的 UI 基础验收仍以 #389 完成为前提。

### 导出设计验收矩阵

`tests/design-contract.ts` 定义导出包的九种视口：360×800、390×844、430×932、600×960、
820×1180、1024×768、1366×768、1440×900、1920×1080。
矩阵在 desktop project 中逐一切换视口；mobile project 不重复执行同一矩阵。
每次捕获保留截图及布局测量，检查页面无横向溢出、72px 顶栏、248px 桌面侧栏及主题 tokens。
页面须先出现业务内容或可操作表单，不能仅凭加载页的标题就判定默认状态通过。

| 页面/状态 | 浏览器测试文件 | 截图标识 |
| --- | --- | --- |
| 工作台 | `workbench-recent.spec.ts` | `workbench` |
| Agent 目录、详情 | `management.spec.ts` | `-agents`、`-agents-agent-pilot-1` |
| 对话 | `conversation-routing.spec.ts` | `conversation` |
| 我的申请、已创建 Agent | `management.spec.ts` | `-my-agents`、`my-agents-owned` |
| 创建、编辑申请 | `management.spec.ts` | `-my-agents-new`、`-my-agents-application-browser-1-edit` |
| 申请详情 | `management.spec.ts` | `-my-agents-application-browser-1` |
| Owner 配置 | `management.spec.ts` | `-agents-agent-pilot-1-configuration` |
| 创建审批 | `management.spec.ts` | `-admin-approvals` |
| 管理员 Agent 列表 | `admin-agents.spec.ts` | `admin-agents` |
| 个人、平台审计 | `audit.spec.ts` | `-audit`、`-admin-audit` |
| 运维观测（导出设计未覆盖，按[运维观测页](#运维观测页)） | `ops.spec.ts` | `ops` |

关键状态与行为另由以下测试覆盖，不增加原型状态产品路由：

- `management.spec.ts`：申请/审批/配置的 pending、loading、empty、error、权限拒绝、长字段，
  移动 Sheet 的焦点、Escape、导航关闭及桌面断点关闭。
- `my-agents-design.spec.ts`：我的 Agent `?tab=owned` 深链、刷新与返回，申请列表分批显示与带对象名的入口，
  申请表单 Tab 顺序（高级配置收起与展开）、字段错误，以及申请详情的页头操作、三步进度和「下一步」。
- `conversation-routing.spec.ts`：加载与 503 恢复、403 拒绝、不可用历史只读、深链/返回、
  窄屏历史切换与消息输入区。失败状态沿用对话标题层级，返回目录不产生业务写入。
- `conversation-live.spec.ts`、`conversation-markdown.spec.ts`：消息、模型保存、执行详情、
  模型回退弹窗（请求模型与实际模型、旧事件的中性文案）、
  长正文和代码/表格局部滚动。
- `conversation-screen.test.tsx`：终态经事件或历史回读后清除等待提示并刷新最近会话，
  新建会话成功后刷新最近会话。
- `use-agent-detail.test.tsx`：生命周期过渡到 ready 后更新展示数据并停止轮询；403/503 不继续轮询。
- `ops.spec.ts`：运维观测在 1440×900 与 390×844 下的页头、卡片、chip、事实列表和横向溢出，
  以及未接入、读取中、不可用（含重试焦点）、无权限（不发出观测查询）四种状态。

截图反映受控 API fixture，不证明 LDAP、真实模型、Kubernetes 或独立 Connection 验收。
数据条数、身份、模型选项、权限相关操作与导出样例的差异须以实际契约为准；
原型里的平台就绪、风险评级、保存草稿和示例凭证不能作为生产能力移植。
测量通过仍须回读截图；PR 中记录绑定当前 head 的报告、视觉差异及人工结论。
