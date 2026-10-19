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
| `index.html` | `f66a8694aecee90322161e9a31d682073919ae846d488312e225edf03232aaaf` |
| `login.html` | `6e04830eb0aac86e7ffea6dc6f3db0faab7942e2379c6230efe0512519d0c0a7` |
| `DESIGN.md` | `162e8fb0c381cb96da71a0f838c8ce80b7076ebb6b08071cc2845961e481da18` |
| `IMPLEMENTATION.md` | `3ee03b85afb5567576ff2ac64c1459b811490591d52e16c048809d173bc75a3b` |
| `DESIGN-HANDOFF.md` | `3f2313d6d72bf3d7263d1e864730278217836ccdd5730d4b83460518bd2d3396` |
| `DESIGN-MANIFEST.json` | `3c78fd40eac65ac1659f0ab4934a3b9285a5cb67f85038a42dfdb17df95ffdea` |

`src/index.css` 将暖灰背景、石墨文字、蓝色主操作、状态色、10px 控件圆角和 14px 面板圆角
映射到现有 shadcn 变量，并提供设计同名别名（`--bg`、`--fg`、`--surface-raised`、`--accent`、
`--accent-soft`、`--danger`、`--shadow`、`--font-body`、`--font-mono`）与 ink 色
（`--accent-ink`、`--success-ink`、`--warning-ink`、`--danger-ink`、`--muted-ink`）。
设计 `--muted` 是文字色，对应 `--muted-foreground`。主按钮、eyebrow、占位符和帮助文字使用 ink 色；
等宽文字只引用 `var(--font-mono)` 或 Tailwind `font-mono`。
页面共享内容宽度、标题和表单样式；桌面侧栏为 248px，
低于 1024px 使用现有 Sheet。工作台先展示最近对话和职责事项，再展示 Agent 与申请。
Agent 详情中的 Owner、渠道、模型和范围均取自实际投影；Owner 配置入口仍由权限结果控制。
侧栏「我的 Connection」、对话「会话上下文」中的 Connection 提示与 Agent 详情「打开 Connection」
只由 `src/features/connection-entry.ts` 生成：先按服务端规则分别校验原始 `publicOrigin` 与
`mcpPath`，再拼接并确认 origin 不变。
对话时间线独立滚动，保留消息输入区及代码、表格的局部滚动。
短视口（高度不超过 600px）只压缩页头与间距，仍只有时间线一处滚动；执行详情是模态弹窗，关闭后焦点回到触发按钮。

原型中的示例人员、模型、就绪提示和演示操作不作为生产数据或新增能力。
申请、审批、配置、生命周期及审计继续复用现有组件、请求和权限校验。

### 与导出设计的已定差异

以下差异已在 #2862、#2863 确认，实现与验收以这里为准，等待设计稿回写：

| 位置 | 实现 | 依据 |
| --- | --- | --- |
| `Button` `size="sm"`（返回链接、卡片按钮） | 最小高度 44px，不采用 `.btn-sm` 的 38px | DESIGN.md 触达下限 |
| 顶栏 | 不展示「平台就绪」 | 平台健康属于运维入口（PRD §11.1） |
| 创建审批 | 没有「风险」筛选与列 | 审批看资源规格与准入（PRD §5.1、§6.2） |
| 审批列表、申请详情 | 不展示 `app-024` 式申请编号 | PRD 没有申请编号 |
| 浏览器卡终态 | 不提供「重新请求」 | PRD §11.4、§13.3 |
| Skill 发布范围 MEMBER | 文案为「全体成员」 | PRD §11.5 |
| 个人 API 凭证 | 不提供轮换；已撤销行只显示撤销时间 | PRD §7.3 |
| Builder、预览 | 不提供页面 | PRD §1、§5.7、§11.1 |

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
| `Timestamp` | 工作台、审批、审计、应用管理、个人 API 凭证、我的 Agent、申请详情与对话历史的时间 |
| `IdentifierText` | 审批与审计中未解析人员的 ID 短形式；审计列表对象 ID 用 `shortIdentifier` 等宽短形式，完整值只在记录详情 |
| `Listbox` / `ListboxOption` | 目录选择器结果层与对话 `/` 命令弹层；候选不进入 Tab 序列，由输入框的 `aria-activedescendant` 导航 |
| `DropdownMenu` | 对话输入框工具栏的模型与思考菜单（`menuitemradio`，向上展开，无入场动画） |
| `Collapsible` / `CollapsibleTrigger` / `CollapsiblePanel` | 对话页「会话上下文」「会话文件」折叠条（替代原生 `details/summary`）；面板默认 `keepMounted`，收起只隐藏不卸载 |

时间统一由 `src/lib/format-time.ts` 按浏览器本地时区与自然日格式化，`<Timestamp>` 渲染
`<time dateTime title>`，`title` 为带秒的完整本地时间。人员与组织显示名由
`src/features/directory-names.tsx` 的 `useDirectoryNames` 页面级批量读取：单元格和 chip 不放
`role="status"`，读取失败时页面只显示一条提示与「重新读取目录」，主文字不回退到内部 ID。
标准模板只显示部署配置登记的显示名：路由（或页面 workflow）用 `src/features/template-display-name.ts` 的
`useTemplateNameLookup()` 读取并传给页面，读不到时显示「标准模板」，不显示原始 `templateId`。

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

关键状态与行为另由以下测试覆盖，不增加原型状态产品路由：

- `management.spec.ts`：申请/审批/配置的 pending、loading、empty、error、权限拒绝、长字段，
  移动 Sheet 的焦点、Escape、导航关闭及桌面断点关闭。
- `my-agents-design.spec.ts`：我的 Agent `?tab=owned` 深链、刷新与返回，申请列表分批显示与带对象名的入口，
  申请表单 Tab 顺序（高级配置收起与展开）、字段错误，以及申请详情的页头操作、三步进度和「下一步」。
- `conversation-routing.spec.ts`：加载与 503 恢复、403 拒绝、不可用历史只读、深链/返回、
  窄屏历史切换与消息输入区。失败状态沿用对话标题层级，返回目录不产生业务写入。
- `conversation-live.spec.ts`、`conversation-markdown.spec.ts`：消息、模型保存、执行详情、
  长正文和代码/表格局部滚动。
- `conversation-screen.test.tsx`：终态经事件或历史回读后清除等待提示并刷新最近会话，
  新建会话成功后刷新最近会话。
- `use-agent-detail.test.tsx`：生命周期过渡到 ready 后更新展示数据并停止轮询；403/503 不继续轮询。

截图反映受控 API fixture，不证明 LDAP、真实模型、Kubernetes 或独立 Connection 验收。
数据条数、身份、模型选项、权限相关操作与导出样例的差异须以实际契约为准；
原型里的平台就绪、风险评级、保存草稿和示例凭证不能作为生产能力移植。
测量通过仍须回读截图；PR 中记录绑定当前 head 的报告、视觉差异及人工结论。
