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
| `index.html` | `640d27b6899023b21c1148d366c0874eff248cb4472347b753f38142c9dcd62a` |
| `login.html` | `aa0a2737e7bc76f56c2552abfb503879a3c9f5c0919adfd7b65decd27b3ba6a7` |
| `DESIGN.md` | `fa953264eafe4e0bd05adaa86387a9d90ad7af51d4e79f0a67620bfa31596d65` |
| `IMPLEMENTATION.md` | `ae3e592272933f65a0f7fc34363142a4471a724f7a75db76affe6ae12d640600` |
| `DESIGN-HANDOFF.md` | `3f2313d6d72bf3d7263d1e864730278217836ccdd5730d4b83460518bd2d3396` |
| `DESIGN-MANIFEST.json` | `082fd76e5eb5c42f24d64974683fcb264c93b045824b3bb00a909f7d2b66fe1a` |

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

对话结果文件预览属于会话文件卡的增量能力，不新增独立 `/preview` 页面：预览读取沿 File Grant
取得一次性 Blob，文本、图片、PDF 和统一 diff 在卡片弹窗内展示，静态 HTML 使用隔离 iframe；
无法预览的类型继续提供下载。该能力不改变 Builder/独立开发服务预览仍不属于 M1 的结论。

原型中的示例人员、模型、就绪提示和演示操作不作为生产数据或新增能力。
申请、审批、配置、生命周期及审计继续复用现有组件、请求和权限校验。

### 已回写导出设计的结论

以下结论已在 #2862、#2863、#2903、#2996 与 #2830 终验（#3037–#3041、#3046、#3052，第二轮 #3127–#3130，第三轮 #3160、#3161，第四轮 #3179、#3180，第五轮 #3215、#3216，第六轮 #3235、#3236）确认，
并由 [#2863](https://github.com/AgoraIO-Extensions/agent-infra/issues/2863)、
[#3107](https://github.com/AgoraIO-Extensions/agent-infra/issues/3107)、
[#3130](https://github.com/AgoraIO-Extensions/agent-infra/issues/3130)、
[#3161](https://github.com/AgoraIO-Extensions/agent-infra/issues/3161)、
[#3180](https://github.com/AgoraIO-Extensions/agent-infra/issues/3180)、
[#3216](https://github.com/AgoraIO-Extensions/agent-infra/issues/3216) 与
[#3236](https://github.com/AgoraIO-Extensions/agent-infra/issues/3236) 回写本版导出稿；实现与验收以这里为准：

| 编号 | 位置 | 实现 | 依据 |
| --- | --- | --- | --- |
| B-15 | `Button` `size="sm"`（返回链接、卡片按钮） | 最小高度 44px；卡片内 40px 档只用于我的 Agent 卡、申请详情页头与下一步、提交结果、Owner 配置危险区和管理员操作区 | DESIGN.md 触达下限 |
| S-01 | 顶栏 | 不展示「平台就绪」 | 平台健康属于运维入口（PRD §11.1） |
| AP-01 / AP-02 | 创建审批 | 没有「风险」筛选与列 | 审批看资源规格与准入（PRD §5.1、§6.2） |
| F-05 / M-11 | 审批列表、申请详情 | 不展示 `app-024` 式申请编号 | PRD 没有申请编号 |
| BR-03 | 浏览器卡终态 | 不提供「重新请求」 | PRD §11.4、§13.3 |
| K-05 | Skill 发布范围 MEMBER | 文案为「全体成员」 | PRD §11.5 |
| R-02 | 个人 API 凭证 | 不提供轮换；已撤销行只显示撤销时间 | PRD §7.3 |
| R4-06 | 对话标题 | 标题展示遵循 PRD | [PRD §12.2](../prd/PRD-agent-platform-M1.md#122-会话历史) |
| CK-04 | 新会话首条消息前的「/」 | 不提供命令与 Skill 目录，说明「发送第一条消息后可使用命令与 Skill。」 | [工程 Spec §11.4](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#114-原生命令与已安装-skill-边界) |
| R-04 | Builder、预览 | 不提供页面 | PRD §1、§5.7、§11.1 |
| O-02 | Agent 的 Skill 绑定卡 | 增加「解除绑定」，确认后提交不含该项的完整集合 | #2903 AC-1、[工程 Spec §11.6](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#116-skill-hub版本绑定与-worker-装配) |
| D-01 | Agent 详情「连接器」的「打开 Connection」 | 1440 与 390 视口都是 44px，与对话页 Z-11 共用同一条规则 | DESIGN.md：新操作至少 44px（触达下限）；B-15 的 40px 档不含 Connection 提示（[#3052](https://github.com/AgoraIO-Extensions/agent-infra/issues/3052)） |
| V-01 | `/admin/approvals` 审阅弹窗事实 | 「申请人」取申请投影，缺失写「未提供」；来源按类型标为「模板 / 多服务清单 / 镜像」，范围标为「使用范围」，并列出说明、Owner、默认模型、默认推理强度、预设规格与预计资源占用 | 标签说明值是哪类引用；审批看来源、资源规格与准入（[PRD §5.1](../prd/PRD-agent-platform-M1.md#51-准入与部署)、[§6.2](../prd/PRD-agent-platform-M1.md#62-审批规则)） |
| V-04 | `/admin/agents` 页头 | gray 计数 chip 后保留 44px ghost「刷新 Agent 列表」 | 列表的重读入口，形态与审计页头一致（#2820 AA-01） |
| V-07 | `/admin/skill-reviews` 本人发布的版本 | 不渲染禁用的「审阅」，改为文字「不能审核自己发布的版本」 | 禁用按钮不可聚焦，读屏得不到原因；创建者不能批准自己的共享发布（[PRD §11.5](../prd/PRD-agent-platform-M1.md#115-skill-hub)） |
| V-08 | `/audit` 筛选与列表 | 外置三项筛选后保留「更多筛选 / 重置 / 查询」，表格后保留分页 | 按时间、主体、Agent、动作、结果和执行引用筛选并分页（[PRD §13.2](../prd/PRD-agent-platform-M1.md#132-查询与权限)），以提交为准 |
| V-09 | `/audit` 记录详情 | 审计 V2 字段按「操作与身份 / 请求与执行关联 / 请求尝试结果 / 实际执行事实 / Connection 关联」分组，另有「刷新审计详情」 | 字段集合以审计 V2 投影为准（[工程 Spec §18.3](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#183-持久审计)），分组保持可读；刷新用于回读待核实结果（[PRD §13.3](../prd/PRD-agent-platform-M1.md#133-真实结果与可靠性)） |
| V-10 | `/admin/audit` 列表区 | 筛选与分页同 V-08；表格前保留「事件时间线 / 平台操作记录」与右侧说明，表格后保留「最小审计数据」notice | 原 #400 管理员审计 IA（#1199 AC-1）；说明审计不保存正文、关联引用不授予查询权限（[PRD §13.1](../prd/PRD-agent-platform-M1.md#131-记录范围)、[§13.2](../prd/PRD-agent-platform-M1.md#132-查询与权限)） |
| V-11 | `/admin/audit` 记录详情 | 同 V-09 | 同 V-09 |
| V-13 | `/skills/:id` 版本与权限、适合什么工作 | 不显示「文件权限」行；用途第二条为「不会增加模型、文件或 Connection 权限。」 | 版本详情投影不含逐版本文件授权（[工程 Spec §11.6](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#116-skill-hub版本绑定与-worker-装配)），不伪造；「脚本：禁用」「网络权限：不会新增」与用途说明已表达不扩大权限（[PRD §11.5](../prd/PRD-agent-platform-M1.md#115-skill-hub)） |
| V-14 | `/skills/:id` 390 侧栏事实行 | 侧栏仍为两列，dt 与 dd 对齐，不加 8px dt 上距 | ≤767 的 `.facts dt{margin-top:8px}` 只适用于单列事实列表（原导出稿缺陷） |
| V-17 | `/skills/manage` 已安装行 | ghost「查看」之外保留「移出我的库」；名称下为「固定版本 v… · 来源」与发布状态 chip，可附「有新版本」chip，右侧为固定版本号；不显示绑定状态 | 移出我的库（#2953）；新版本只提示可升级，安装与 Agent 配置分开展示（[PRD §11.5](../prd/PRD-agent-platform-M1.md#115-skill-hub)），版本、来源与发布状态取安装投影，安装投影不含绑定（C2-10） |
| V-18 | `/skills/manage/new` 编辑与发布 | 两栏与右栏四张范围单选卡按设计；左栏首段为「项目信息」（包名称、项目状态、保存项目），没有「显示名称」与 ZIP 上传，内容区另有配套文件与「上传文件到 assets/」；「保存草稿」保存项目内容；字段名为「版本号」，有未保存修改时主按钮为「保存并发布 / 保存并提交审核」；导入区字段名为「导入包名称」 | 项目只有包名称，发布只提交内容修订、版本号与范围，不接收上传包；网页编辑的项目内容即项目草稿（[工程 Spec §11.6](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#116-skill-hub版本绑定与-worker-装配)）；同一页面不出现同名控件 |
| V-19 | `/skills/manage/new` 新建首屏 | 先「Skill 项目」（包名称、创建项目）与导入区，右栏只有说明；创建后进入该项目，出现内容与发布 | 项目内容只属于已创建的项目，并按项目内容修订号 CAS（[工程 Spec §11.6](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#116-skill-hub版本绑定与-worker-装配)），没有项目时不能保存内容或发布 |
| W-06 | 创建、修改申请「基本信息」 | 字段依次为 Agent 名称、使用场景、来源；来源与标准模板（或镜像地址、多服务 YAML、入口身份校验）分两级选择 | [PRD §6.1](../prd/PRD-agent-platform-M1.md#61-创建申请)先列名称和说明，再列来源、镜像与交互入口归属；单个来源下拉无法表达交互入口归属与多服务 |
| W-07 | 申请表单「使用场景」帮助文字 | 保留「不填写模型内部思考或外部凭证。」；分区说明与目录占位符已按导出稿 | 导出稿按 main 文案回写；`design-tokens.spec.ts` 的帮助文字断言锁定该文案 |
| W-09 / H5-09 | 修改申请页头 | eyebrow「我的管理 / 编辑申请」，h1 为「修改申请」或「修改并重新提交」；重新提交后的结果页仍为「我的管理 / 编辑申请」，h1「申请已提交」 | 动作名沿 [PRD §6.3](../prd/PRD-agent-platform-M1.md#63-管理状态)；结果页仍在修改申请的地址上（`agent-application-submission-screen.tsx`），原导出稿提交后清空编辑语境、改成「创建申请」 |
| W-10 | 修改申请表单 | 步骤条、分区说明与占位符同创建页；字段顺序与帮助文字同 W-06、W-07 | 同 W-06、W-07 |
| W-13 | 申请详情审批进度 | 已有审批结果时第二步写「审批时间 …」；侧栏「下一步」按申请状态给出去向；副标题、首步「时间 · 申请人」与驳回标题已按导出稿 | 审批时间取服务端投影；已撤回、已驳回、创建失败等状态的去向不同（[PRD §6.2](../prd/PRD-agent-platform-M1.md#62-审批规则)、[§6.3](../prd/PRD-agent-platform-M1.md#63-管理状态)），不用固定文案 |
| W-14 | 申请详情侧栏 | 「申请配置」列来源、镜像地址、入口身份责任、Owner、更新于、使用范围、模型范围、默认模型与默认推理档位，另有「资源预设」；申请人移到进度首步 | 申请人可核对已提交的全部内容（[PRD §6.1](../prd/PRD-agent-platform-M1.md#61-创建申请)）；资源预设即 [PRD §5.1](../prd/PRD-agent-platform-M1.md#51-准入与部署)的标准资源规格 |
| W-17 | Owner 配置「渠道」分区 | 标题与说明按导出稿；说明之后保留群聊可见性提示 | Owner 绑定群聊时必须看到该提示（[PRD §10.3](../prd/PRD-agent-platform-M1.md#103-企微会话)） |
| W-24 | 企微机器人「扫码授权暂不可用」面板 | 只有底部一个「关闭」，头部不再放同名按钮 | 同页不出现同名控件 |
| W-25 | 同上面板的说明 | 「扫码能力由服务端按当前部署判定，当前不会伪造绑定成功。」 | 不外露 setup session 内部术语 |
| W-27 | 企微应用回调 URL 块 | 标题为「请在企微后台配置回调 URL」 | 平台不自动覆盖已有应用的回调，需 Owner 自行配置（[PRD §10.2](../prd/PRD-agent-platform-M1.md#102-渠道绑定)） |
| W-29 | 替换 Secret 弹窗 | 说明前显示被替换的 Secret 名称 | 同页有多个 Secret，弹窗需写明操作对象，与 `ConfirmDialog` 的 subject 一致 |
| W-31 | Agent 的 Skill 页绑定表单标题 | 保留「绑定固定版本」 | 候选是 Skill Hub 中当前用户可见的已发布版本（[PRD §11.5](../prd/PRD-agent-platform-M1.md#115-skill-hub)「已获准 Skill 版本」），不限于「我的库」，「从我的库绑定」与实际来源不符 |
| W-32 | 同上表单的绑定按钮 | 宽度撑满右栏；高度保持公共 44px | 原导出稿 1440 下的 47.3px 来自左栏标签未套字段样式后的栅格拉伸（W-33） |
| W-33 | 同上表单的「固定版本」标签 | 公共字段标签 12px / 650 / muted | 与公共字段标签一致（原导出稿 `label > span` 未套字段标签样式） |
| W-34 | Agent 的 Skill 页空态 | 与上方版本提示相距 32px（窄屏 26px），与绑定卡一致 | 与绑定卡的分区间距一致（原导出稿空态缺少 `.section` 间距、紧贴提示） |
| W-35 | 绑定卡操作 | 在对话中选择（可用时）、更换固定版本、版本详情、解除绑定 | 绑定投影没有升级提示；「更换固定版本」由 Owner 明确选择升级或回滚的目标版本（[PRD §11.5](../prd/PRD-agent-platform-M1.md#115-skill-hub)、[工程 Spec §11.6](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#116-skill-hub版本绑定与-worker-装配)） |
| X-04 | 公共 `Dialog` 页眉的图标关闭钮（执行详情、浏览器操作记录、模型回退等） | 可访问名称为「关闭弹窗」，页脚文字按钮仍为「关闭」 | 可访问性：同一弹窗不出现同名控件 |
| X-06 | Owner 配置 Skill 分区（≤767px） | 「管理 Skill 绑定」换到说明下方，保持 44px 单行按钮 | 按钮不挤在标题右侧折成两行（原导出稿为 116.5×62.9px） |
| X-08 | 创建审批 390 卡片表格的「申请」「来源 / Owner」 | 值放在同一个容器内，名称与 `small` 右对齐上下排列 | `.table-wrap td{display:flex}` 下 `td small` 不能成为第三个 flex 项，否则名称被挤到标签与 `small` 之间（原导出稿缺陷） |
| X-10 | 管理员 Agent 390 卡片表格的「Agent 名称 / 说明」 | 同 X-08 | 同 X-08 |
| X-12 | 审计 390 卡片表格的「对象」（名称 / ID 短形式） | 同 X-08 | 同 X-08 |
| X-13 | Skill Hub 读取失败、无匹配空态 | 图标下方 11px，其余高度按网格行均分 | 图标不作为行内元素放进文字块（原导出稿 `skillEmpty` 基线下多出约 6.8px，图标到标题 17.8px） |
| Y-03 | 窄屏导航 Sheet 头部 | 保留右上角 44px ghost 图标按钮「关闭导航」，品牌块让出 48px，两者命中区不重叠；遮罩与 Esc 仍可关闭，关闭后焦点回到「打开导航」 | 可访问性：模态导航提供可见、可触达的关闭控件，不只依赖 Esc 或遮罩 |
| Y-04 / H4-19 / H4-25 / H5-14 / H5-19 / J6-01 / J6-02 | 侧栏「个人 Relay Key」「API 凭证」「我的 Connection」「Skill 审核」「评测」「我的执行审计」「平台审计」「运维观测」图标；企微「扫码授权」与配置类入口的图标；刷新与重试图标；Agent 图标；停止与执行中图标 | 沿用 lucide `KeyRound`（17px）；「扫码授权」为 lucide `Scan`（只有四角）；Agent 详情「Owner 配置」、已创建卡「配置与生命周期」、申请详情「修改申请」、思考强度入口、`/admin/agents`「配置」、`/skills/manage`「Agent 绑定」与「改用手动配置」为 lucide `Settings` 齿轮；刷新、重试、重新读取（`/admin/agents`「刷新 Agent 列表」与行内「重试」、`/ops`、`/audit`、`/admin/audit`、「重启 Agent」、状态卡「重新加载…」）为 lucide `RefreshCw`（顺时针，箭头在右上与左下）；侧栏「Agent 目录」、回复卡头像、模型入口与 404「前往 Agent 目录」为 lucide `Bot`（折线天线、两侧耳朵、两道竖眼）；侧栏「Skill 审核」、个人 Relay Key 与 API 凭证页提示、Skill 审核行为 lucide `Shield`（无对勾），Owner 配置「权限边界」为 `ShieldCheck`；侧栏「评测」为 `FlaskConical`；侧栏「运维观测」、Agent 详情「运行与渠道」、浏览器卡「执行中」卡头与「正在校验默认 Key」为 `Activity`（17px 下约 13.9px 高）；侧栏「我的执行审计」「平台审计」为 `ClipboardMinus`（一道横线）；「停止回复」「停止操作」「停止 Agent」与浏览器卡「已停止」「工具调用失败」卡头为 `Square`（16px 下 12px 方块）；导出稿 path 逐段取自 lucide-react 1.41.0 的 shield、shield-check、flask-conical、activity、clipboard-minus、square | 全站 key 语义（侧栏、连接器提示、对话上下文条、Connection 安装面板、Secret、Relay Key、API 凭证空态）统一为同一字形；只换侧栏会让同页出现两种 key 图标；scan、settings、refresh、bot、shield、activity、clipboard、stop 同理，全站同一语义只用一种 lucide 字形（G4-06、G4-10；原导出稿 `scan` 带中心方块，`settings` 为圆加四段短弧，`refresh` 为逆时针自绘字形，`bot` 为圆角框、竖直天线与带嘴的两点眼睛；J6-01、J6-02：`shield` 为自绘带勾盾牌，「评测」与「运维观测」共用纵向 5–19 的自绘 `activity`（17px 下约 9.9px 高），`clipboard` 为两道横线，`stop` 为 12×12 方块（16px 下 8px）） |
| Y-09 | 工作台「待处理」管理员行 | 系统管理员另有一行「运行状态 / N 个 Agent 创建失败 / 查看失败清单」，进入 `/admin/agents?status=creation_failed`；Owner 行按导出稿对齐 | 系统管理员可代替 Owner 重试创建失败的 Agent（[PRD §2.3](../prd/PRD-agent-platform-M1.md#23-系统管理员)、[§6.3](../prd/PRD-agent-platform-M1.md#63-管理状态)） |
| Z-02 | 对话 composer 的发送按钮 | 草稿为空且没有选中命令或 Skill 时禁用 | 消息命令 `MessageCommandRequestV1.text` 必须非空；禁用比无反馈的点击更清楚 |
| Z-04 | 已完成回答的状态行 | 「已完成 · 重新生成 · 查看执行详情」：已完成、失败与已停止的回答都可重新生成；不显示「n 步」 | [PRD §11.2](../prd/PRD-agent-platform-M1.md#112-对话能力)：重新生成基于同一条用户消息产生新回答，服务端只要求会话没有活跃回复。会话投影没有步数，过程摘要在执行详情 |
| Z-06 | 对话页个人历史面板 | 列表下保留 ghost「此 Agent 的全部历史」与「最近对话」切换 | 面板默认是跨 Agent 的最近对话，切换后才是当前 Agent 的分页历史（[PRD §11.2](../prd/PRD-agent-platform-M1.md#112-对话能力) 查看历史会话、[§12.2](../prd/PRD-agent-platform-M1.md#122-会话历史)） |
| Z-08 | 对话页浏览器卡 | 只有「可请求」卡在默认收起的「会话上下文」里；等待确认、接管、执行中与终态（含待核实）卡在会话时间线末尾，页面始终只有一张 | NI-83：需要处理或进行中的内容不放进可收起的折叠条；BR-01：对话页只有一张浏览器卡。[PRD §11.4](../prd/PRD-agent-platform-M1.md#114-浏览器能力) 的用户接管与外部副作用确认、取消须随时可操作；[§13.3](../prd/PRD-agent-platform-M1.md#133-真实结果与可靠性) 不把取消请求当作取消完成，无法确认的外部结果显示待核实 |
| Z-10 | 浏览器卡正文 | 等待确认「请确认这次操作范围，确认前不会执行。」；已拒绝「这次操作没有执行，也没有产生外部操作。」；工具调用失败「操作没有完成，页面是否产生变化需要重新核实。」；真正停止时用导出稿原文 | 等待确认来自外部副作用确认（[PRD §11.4](../prd/PRD-agent-platform-M1.md#114-浏览器能力)），发生在已打开的页面上，原导出稿「Agent 还没有打开页面」「没有打开页面」与事实不符；失败不等于停止 |
| Z-11 | 对话「会话上下文」的「打开 Connection」 | 1440 与 390 视口都是 44px | DESIGN.md：新操作至少 44px，390px 下跳转按钮保持 44px；B-15 的 40px 档不含 Connection 提示 |
| Z-12 | Agent 已停止时的 composer | 输入框、「命令 / Skill」、模型与思考入口和发送一起禁用；启动中、更新中仍可编辑草稿 | [PRD §12.2](../prd/PRD-agent-platform-M1.md#122-会话历史)：Agent 不可用时 Web 历史只读、不能继续发送（#1607、#1911） |
| Z-13 | 处理中的回复卡 | 状态行保留「查看执行详情」 | [PRD §14.1](../prd/PRD-agent-platform-M1.md#141-调用方的执行详情)：用户可查看实际经历的受理、等待、执行与工具调用阶段，长任务处理中也能查看已有过程 |
| Z-14 | 停止回复后的回复卡 | 显示实际已生成的正文；没有正文时只有状态行「已停止 · 可重新生成 · 重新生成 · 查看执行详情」，并用 Toast「回复已停止」补充确认 | R4-08：失败与停止只用一行状态说明；「回复已停止，已保留当前已生成内容。」式演示正文在没有生成内容时与事实不符 |
| B2-03 | 目录选择器 chip 的移除按钮（申请表单、Owner 配置、员工访问控制） | 可访问名称先写选择器标签、再写对象名，如「从可使用的用户移除 陈昊」「从共同 Owner 用户移除 陈昊」；按钮仍只显示图标 | 可访问性：同一人员同时选入「共同 Owner 用户」与「可使用的用户」时，同页不出现同名控件（[#3128](https://github.com/AgoraIO-Extensions/agent-infra/issues/3128)，原导出稿为「移除 陈昊」×2） |
| C2-04 / D2-35 | `/admin/skill-reviews` 审阅弹窗「审核说明 · 驳回时必填」 | 标签为公共字段标签 12px / 650 / muted；与正文区相距 32px（窄屏 26px） | 同 W-33：原导出稿 `label > span` 未套字段标签样式（[#3129](https://github.com/AgoraIO-Extensions/agent-infra/issues/3129)） |
| C2-18 / D2-45 / D2-46 / D2-47 / D2-48 / D2-54 / F3-14 | `/skills/manage/new` 编辑与发布（V-18） | 左栏分区标题、说明与帮助文字沿用公共 `FormSection`（标题 620 / 1.35，说明 13px，帮助 11px `--muted-ink`，「共 N 个文件…」统计行同为帮助文字），右栏提示 12px / 1.7 `--muted-ink`；「项目状态」与「包名称」的标签、控件顶对齐；范围卡按公共单选指示器排版（13px、无额外外边距），「组织共享」不可选时置灰；SKILL.md 为空时错误在编辑框下方（12px `--danger-ink`），版本号错误在版本号下方，焦点回到出错字段；「上传文件到 assets/」的文件选择按钮为公共 `Input` 样式（12px / 500、无边框、透明底，申请表单的「多服务资源 YAML」文件输入相同）。编辑框高度、版本号上距与「添加文本文件」图标按导出稿 | 原导出稿缺陷：编辑器外层 `.surface.skill-section` 让 `.skill-section` 的标题与段落样式渗入表单，与公共分区（V-03）不一致；`.scope-option` 原生 radio 带 UA 外边距挤窄文字列，且没有禁用样式；「项目状态」标签被网格行高拉伸到 32.4px，下拉比输入框低 12.6px；发布错误被 `.skill-section p` 改成 `--muted`，`render()` 后焦点落到 body（[#3129](https://github.com/AgoraIO-Extensions/agent-infra/issues/3129)）；统计行被 `.form-section > p` 改成 13px `--muted`，文件选择按钮为 UA 默认外观（[#3161](https://github.com/AgoraIO-Extensions/agent-infra/issues/3161)） |
| D2-03 / F3-01 | Agent 详情「连接器」 | 说明与 Connection 提示卡相距 12px，卡片下方不再另留外边距；连接器是左栏最后一个分区，不留下内边距，提示卡底到左栏卡片底 21px | 原导出稿说明贴着卡片边框（`.connection-notice` 的 14px 只在卡片下方），最后一个分区保留 `.detail-section` 的 20px 下内边距，提示卡底到左栏卡片底为 41px |
| D2-04 | 新会话（尚未发送第一条消息） | 不显示「会话文件」折叠条 | 会话文件属于已创建的会话；新会话还没有会话 |
| D2-05 | 对话页浏览器卡的人工接管 | 分两态：「等待接管」正文「请接管浏览器完成 MFA 验证，然后把控制权交还给 Agent。接管期间 Agent 不会操作页面。」，操作「接管浏览器」「停止」；「已接管」正文「请在浏览器中完成 MFA 验证，然后把控制权交还给 Agent。」，操作「交还给 Agent」「停止」。「停止」的可访问名称为「停止接管」；两态都不显示域名、操作与范围 | 接管事件不带域名与操作；原导出稿「等待接管」却给出「交还给 Agent」，状态与操作自相矛盾（[PRD §11.4](../prd/PRD-agent-platform-M1.md#114-浏览器能力)） |
| D2-06 / F3-05 | 浏览器操作记录弹窗 | 五项事实之后另有「操作步骤」列表：每步名称、说明、时间与状态 chip；「操作步骤」标题 13px / 650，行高 1.65 | 记录按操作尝试、人工接管与副作用确认逐条回读，用户可核对实际发生的步骤（[PRD §11.4](../prd/PRD-agent-platform-M1.md#114-浏览器能力)、[§13.3](../prd/PRD-agent-platform-M1.md#133-真实结果与可靠性)）；原导出稿标题沿用 h3 行高 1.4 |
| D2-07 | Agent 已停止时的 composer 输入框（Z-12） | 禁用态透明度 .5 | 禁用态应可辨认 |
| D2-09 | `/my-agents` 申请行 | 「查看申请」之外，待审批行有「修改申请」、已驳回行有「修改并重新提交」，已有 Agent 的申请（含创建失败）有 outline「查看 Agent」；行内操作的可访问名称带申请名 | 动作名同 W-09（[PRD §6.3](../prd/PRD-agent-platform-M1.md#63-管理状态)）；同列次要操作为 outline（B2-01）；同页不出现同名控件 |
| D2-11 / H4-05 | 申请详情「申请配置」卡、Agent 详情左栏「Agent 信息」 | 事实列表不留 UA 默认下外边距：申请配置卡上下内边距对称 20px，Agent 信息末行到分隔线 20px | 原导出稿 `dl.facts` 沿用 UA 默认 13px 下外边距 |
| D2-12 / F3-08 / F3-09 / F3-10 | 创建失败类别（申请详情、Owner 配置页脚、纯管理员视图）与「重试创建」 | `danger` 提示（`role="status"`）「失败原因：{类别}」与下一步说明，只向 Owner 与系统管理员显示：申请详情在进度列表下方（相距 18px，同驳回原因；进度末步不画分隔线、没有下内边距），Owner 视图在页脚按钮下方，纯管理员视图在「权限边界」之后（相距 12px）、「管理员操作」上方。Owner 视图页脚与纯管理员「管理员操作」区的「重试创建」先确认：「重试创建 Agent？」、Agent 名（对象行后 8px）、「将重新尝试创建 Agent，请在创建完成后确认服务状态。」与主按钮「确认重试创建」；受理后 Toast「已提交重试创建请求」，焦点从页脚回到 h1，从「管理员操作」回到该区标题。`/admin/agents` 行内「重试」直接提交（D2-31） | 失败类别取 creation-failure 投影，不展示原因码（[工程 Spec §10.5](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#105-自定义-agent-runtime-manifest)、#3034）；确认文案取 `agent-lifecycle-commands.ts` 的 `retry_creation`，焦点去处同 `configuration-lifecycle.tsx`；原导出稿进度末步后紧跟提示时不命中 `:last-child`，多出 15px 下内边距与分隔线，「重试创建」直接 Toast |
| D2-13 / D2-27 | Owner 配置「渠道」群聊可见性提示（W-17） | 12px、上距 15px、行高 1.65 | 原导出稿 `.form-section > p` 的特异性高于 `.wecom-visibility-note`，提示被渲染为 13px / 上距 5px |
| D2-14 | Owner 配置「可用范围」帮助文字 | 「可选；用于补充个人范围」「可选；组织范围会与用户范围合并」，与申请表单一致 | 不外露「服务端稳定标识」内部术语（同 W-07、W-25） |
| D2-15 | 表单复选框（企微卡片确认勾选、模型档位等） | 复选框不带 UA 外边距 | 原导出稿原生 checkbox 的 UA 外边距让起点右移 4px |
| D2-18 | 企微机器人「扫码授权暂不可用」说明 | 「填写已有机器人的 Bot ID 和 Secret 后」，中英文之间留空格 | CJK 排版 |
| D2-21 | 「替换 Agent 默认 Relay Key」弹窗 | 错误行只在出错时渲染，出错时输入框 `aria-invalid` 并获得焦点 | 与公共 `FieldError` 一致，空的 live region 不常驻 |
| D2-22 / D2-23 / F3-11 | Owner 配置「管理员操作」区与纯管理员视图 | 系统管理员可见中性卡「管理员操作 / 以下操作仅对系统管理员显示。」，40px 档 outline「停用 Agent」（纯管理员且创建失败时另有「重试创建」，确认见 D2-12）；确认弹窗「停用 Agent？」、Agent 名（对象行后 8px）、「停用将撤销运行资格。Owner 不能恢复，个人历史仍保留。」与「确认停用」。停用后页头 chip 为「已停用」（gray），停止危险区、页脚「重启 Agent」与管理员操作区随可用命令消失，「权限边界」之前显示 warn 提示「已停用 / 运行资格已撤销，Owner 无法恢复。」（两条提示相距 12px），配置表单整体禁用，Toast「Agent 已停用」，焦点到 h1。系统管理员不是 Owner 时只显示页头、权限边界与管理员操作；从 Agent 管理进入且不在使用范围内时返回链接为「返回 Agent 管理」。已停用时「Skill」分区的「管理 Skill 绑定」是链接，不随表单禁用，进入只读的 Agent Skill 页（H4-22） | [PRD §2.3](../prd/PRD-agent-platform-M1.md#23-系统管理员)、[§6.3](../prd/PRD-agent-platform-M1.md#63-管理状态)；B-15 的 40px 档；已停用的 Agent 没有生命周期命令，区域卸载时焦点交给 h1（`configuration-lifecycle.tsx`、`configuration-page-heading.tsx`）；见[返回链接与管理区布局](#返回链接与管理区布局)（#3033） |
| D2-26 | Skill 弹窗的对象名（确认绑定、解除绑定、更换版本、撤销版本） | 统一 650 字重 | 与 `ConfirmDialog` 的 subject 一致（原导出稿分别为 400、700、650） |
| D2-29 / D2-37 | 驳回原因（创建审批的驳回弹窗、Skill 审阅弹窗） | 错误行只在出错时渲染；无错误时文本框到操作区 24px；原因为空时提交，焦点移到对应文本框（创建审批为「驳回原因」，Skill 审阅为「审核说明」） | 空的 live region 不常驻（原导出稿常驻空的 `p.field-error[role=alert]`）；出错后焦点停在需要修改的字段（N-06） |
| D2-30 | 公共弹窗页眉的图标关闭钮（X-04） | 图标 18px | 原导出稿 `icon('x',18)` 被 `.btn svg{width:16px}` 覆盖 |
| D2-31 | `/admin/agents` 行操作 | 依次为「配置」、创建失败时「重试」、「停用」，名称带 Agent 名；已停用的 Agent 只显示「—」。停用确认同 D2-22，受理后 Toast「已提交停用请求」，该行只剩「—」时焦点到 h1 | 见[返回链接与管理区布局](#返回链接与管理区布局)（#3033） |
| D2-32 / D2-52 | `/admin/agents` 页头工具（V-04，≤767px） | 计数 chip 不随按钮拉伸，「刷新 Agent 列表」不叠加 16px 上外边距，与 chip 同行 | 16px 只用于换行后的页头操作，操作组内的按钮不再叠加（[返回链接与管理区布局](#返回链接与管理区布局)） |
| D2-33 | 「禁用这名员工？」确认弹窗 | 对象为姓名（650）与邮箱（13px muted）两行 | 与 W-29 一致（`ConfirmDialog` 的 subject） |
| D2-40 / D2-53 | `/skills/:id`「版本与权限」侧栏（V-12） | 已加入我的库时侧栏底部为「移出我的库」，本人已发布的版本另有「撤销此版本」；页头只保留一个主操作 | V-12：加入前后页头只有一个主操作，移出入口在侧栏 |
| D2-41 | `/skills/:id`「我的库」 | 尚未安装 / 正在校验包… / 已在我的库 | 与「加入我的库」「移出我的库」用词一致（#2904 AC-2） |
| D2-42 | `/skills/:id` 撤销确认弹窗 | 说明前显示「名称 · v版本」 | 同 W-29：弹窗写明操作对象 |
| D2-44 | `/skills/manage`「已安装」区头（≤767px） | 「Agent 绑定」保持 44px 单行，不折行 | 同 X-06：按钮不挤在标题右侧折成两行 |
| D2-49 | `/my-settings/relay-key`「Relay Key」 | 公共字段标签 12px / 650 / muted | 同 W-33：原导出稿 `label > span` 未套字段标签样式 |
| D2-55 / H4-06 / H5-03 | 对话页回答上方「思考过程」 | 有思考内容时显示，默认收起；回复处理中且尚无正文时默认展开，正文出现或刷新后收起；停止回复后，已收到的思考过程仍在已停止的回答上方并收起；摘要 44px、12px muted，「展开 / 收起」11px `--accent-ink`；正文 13px / 1.7 muted。执行详情页脚为「这里展示可审计的执行事实，不包含思考过程；模型提供的思考过程显示在回答上方。」 | [PRD §11.2](../prd/PRD-agent-platform-M1.md#112-对话能力)：思考过程显示在回答上方并可折叠（#3012）；原导出稿停止回复后丢掉已收到的思考过程（H5-03） |
| D2-56 / F3-03 | 对话页短视口（高度不超过 600px） | 页头只留 h1（44px），隐藏 eyebrow 与副标题，折叠条省略「按需查看」；会话上下文、时间线、会话文件与输入框之间统一 6px；仍只有时间线滚动 | 见[OpenDesign 视觉版本](#opendesign-视觉版本)短视口规则；原导出稿短视口仍用常规间距（10 / 0 / 18px） |
| D2-57 / F3-07 | 申请表单多服务 YAML 文本框（`#app-manifest`） | 可访问名称「多服务资源 YAML 内容」，占位符三行；最小高 224px，等宽 14px / 20px | 与上方文件输入「多服务资源 YAML」区分（[#3119](https://github.com/AgoraIO-Extensions/agent-infra/issues/3119)）；尺寸同 `agent-application-form.tsx`，原导出稿沿用公共文本框的 110px、15px |
| D2-58（D2-01、D2-02、D2-08、D2-10、D2-16、D2-20） | 同页重复的行内与卡内操作 | 可访问名称为「{可见文字}：{对象名}」：工作台最近对话、待处理、可用 Agent 与我的申请，我的 Agent 已创建卡，企微卡片（「验证并绑定：企微机器人」等），审批「审阅」，Agent 管理行操作，审计「详情：{事件} · {时间}」，Skill Hub 与我的 Skill 行操作；Agent 目录为「查看 {名称} 详情」；回复卡用提问摘要（超过 20 字截断，重复时按出现顺序加「（第 N 次）」）；申请表单可重复的行（模型选项、环境变量、Secret）内的字段、推理档位复选框与「移除」按钮以所在行 legend 为对象名（「模型端点：模型选项 2」「均衡：模型选项 1」「移除 Secret：Secret 1」）；按模型勾选的推理档位复选框（Owner 配置「模型与凭证」、修改申请的 Key 候选）以所属模型为对象名（「均衡：Relay · Internal · gpt-5」）；Owner 配置「环境变量与 Secret」的环境变量行以行序号为对象名（「环境变量名：环境变量 1」「值：环境变量 1」「移除：环境变量 1」，两行选了同一变量名时仍可区分），Secret 行的只读字段以 Secret 名称为对象名（「Secret 名称：RELEASE_KEY」「当前状态：RELEASE_KEY」） | 可访问性：同页不出现同名控件，与 `withObjectName`、`distinctObjectNames` 一致（N-12） |
| D2-59（D2-17、D2-19、D2-24、D2-25、D2-28、D2-34、D2-36、D2-38、D2-39、D2-43、D2-48、D2-50、D2-51）/ F3-13 / I6-01 | 演示动作完成后的焦点 | 弹窗（含 Skill 弹窗）打开时聚焦弹窗容器，只含一个输入框的表单弹窗（「替换 Secret」「替换 Agent 默认 Relay Key」）聚焦该输入框；扫码面板打开后焦点留在「扫码授权」；确认解绑企微后到卡片标题；Skill 绑定或更换固定版本后到该绑定卡标题，解除后到下一张卡标题，没有时到 h1；审批驳回空原因时到「驳回原因」，Escape 关闭后回到「审阅：{申请名}」；申请提交或重新提交后到「申请已提交：待审批。」提示（H4-13）；确认撤回申请后到 h1（H4-15）；Owner 配置确认停止 Agent 后到 h1（H4-21）；确认禁用员工后到「员工访问控制」，取消或 Escape 关闭禁用确认回到「禁用员工：{姓名}」；审计详情打开后到「审计详情」区域，Escape 或「关闭」回到触发按钮；页头刷新（「刷新 Agent 列表」「刷新运维状态」「刷新审计记录」）与「刷新审计详情」读取中保持可聚焦（`aria-disabled`），完成后焦点留在刷新按钮，详情刷新后 Escape 仍关闭详情并回到触发按钮；页头刷新失败、刷新按钮随页头工具收起时到 h1，详情重读失败或「重试详情」恢复后到「审计详情」区域；加入我的库后到「配置 Agent 绑定」，撤销版本后到 h1；Relay Key 保存后到「替换 Key」，撤销后到 Relay Key 输入框（H4-27）；确认撤销 API 凭证后到该行凭证标识，取消或 Escape 关闭撤销确认回到「撤销：{凭证}」；签发或轮换应用凭证后到「应用凭证结果」；停止回复后到该回复卡的「重新生成」；浏览器卡「停止操作」受理后到该回复卡的「正在停止」，停止确认后到浏览器卡「查看操作记录」（没有时同停止回复）；浏览器卡其余命令处理中按钮保持可聚焦（`aria-disabled`），受理并回读到下一阶段后到新卡的下一步操作：允许后到「接管浏览器」（下一阶段为执行中时到「停止操作」），接管后到「交还给 Agent」，交还后到「停止操作」，拒绝与停止接管后到「查看操作记录」（都没有时到输入框，再没有时到 h1）；停用 Agent 与重试创建见 D2-22、D2-12；重绘不收起已展开的折叠条，焦点留在折叠条内的同一控件 | 与 Web 一致：动作完成后焦点在触发按钮、结果标题或 h1，不因整页重绘落到 body（N-06）；单输入框弹窗的初始焦点同 `secret-replace-dialog.tsx`、`default-relay-key-dialog.tsx` |
| F3-02 | 对话页处理中与停止后的回复卡 | 每条提问只有一张回复卡：发送后处理中卡跟在该提问之后，重新生成时在原回答的位置显示处理中卡；停止后在同一位置显示已停止的回答，重新生成被停止时作为该回答的新版本（版本行 x/y）；处理中卡的「查看执行详情」带所答提问的摘要 | 与 Web 一致：回复按提问归组（`conversation-screen-messages.tsx`），同页不出现同名控件（D2-58）；原导出稿处理中卡追加在时间线末尾，与上一条回答指向同一提问 |
| F3-04 | 对话页浏览器卡「工具调用失败」 | 与「已停止」相同：danger 24% 混色边框、红色图标、red「已停止」chip | 失败与停止都需要重新核实页面（Z-10），Web 按已停止阶段呈现（`browser-card.ts`）；原导出稿 `failed` 阶段漏挂 danger 样式 |
| F3-06 | 对话页处理中的 composer | 输入框仍可编辑，发送按钮为「发送补充指令」，草稿为空时禁用；「命令 / Skill」入口禁用（opacity .48、not-allowed） | [PRD §11.2](../prd/PRD-agent-platform-M1.md#112-对话能力)：活跃回复期间按 Runtime 能力接收补充指令或提示繁忙；[§11.3](../prd/PRD-agent-platform-M1.md#113-原生命令与已安装-skill)：活跃回复期间不再启动新的命令任务或 Skill |
| F3-12 | 确认弹窗的对象行（Owner 配置与 `/admin/agents` 的「停用 Agent？」、「重试创建 Agent？」、「撤销这个 Skill 版本？」、「禁用这名员工？」） | 对象名（650）与下方说明相距 8px | 与 `ConfirmDialog` 的 subject 一致；原导出稿前三个弹窗的对象行紧贴说明 |
| F3-15 / H4-30 | 登录页（`login.html`）输入框焦点 | 与 `index.html` 及基础组件相同：2px 焦点环为 26% `--accent`、偏移 3px，聚焦时边框为 `--accent`（字段出错时也是），边框与焦点环没有过渡 | 焦点环在基础组件中统一维护（见[组件与调用方](#组件与调用方)）；原导出稿为 2px 实色 accent、偏移 2px，出错字段聚焦时边框仍为红色 |
| G4-05 | 对话输入框工具栏的模型入口 | 视觉面高 28px，与思考强度入口相同 | 原导出稿 bot 字形包在行内 span 里，行盒把视觉面撑到 29.5px（#3179 G4-05） |
| H4-01 | 窄屏导航 Sheet（≤1023px） | 面板背景为不透明 `--surface`，下层页面不透出；桌面常驻侧栏不变 | 原导出稿 `.sidebar` 为 96% `--surface` 混色，Sheet 打开后页面标题与筛选框透过导航项可见 |
| H4-03 | 工作台「最近对话」状态 chip | 同一状态同一色调：「可用」一律 green | 色调只由 `statusTone()` 按状态映射（见[组件与调用方](#组件与调用方) `Badge`）；原导出稿第三行为 blue |
| H4-04 | 对话入口 `/agents?mode=conversation`（侧栏「对话」、工作台「新建对话」与 `/chat` 重定向） | h1「选择 Agent 开始对话」、副标题「选择当前可用的 Agent，继续文本对话。」，顶栏「工作区 / 选择 Agent 开始对话」，侧栏当前项「对话」；eyebrow 仍为「工作区 / Agent 目录」，筛选与目录相同；可开始对话的卡为主按钮「开始对话」（名称「开始对话：{名称}」，进入该 Agent 的新会话），其余卡保留「查看详情」 | #2297：缺少 Agent 时转到选择页，不默认 Agent；可开始对话的条件同 `canStartPlatformConversation()`（可用、就绪且不是自有交互入口） |
| H4-07 | 对话输入框工具栏「命令 / Skill」 | 菜单打开（`aria-expanded="true"`）时文字 `--fg`、底 `--surface-raised`，与模型、思考入口的展开态一致 | 公共 ghost 按钮的展开态；原导出稿展开后仍为默认的 muted 文字、透明底 |
| H4-09 | 对话页时间线末尾的浏览器卡（Z-08） | 没有下外边距，卡底到时间线底与普通消息结尾相同 | 原导出稿 `.browser-capability{margin-bottom:14px}` 是浏览器卡放在消息上方时的规则 |
| H4-10 | 对话页模型回退 | 回复卡主状态行之后另起一行「模型回退 · 实际模型 {名称} · 查看模型状态」（与上一状态行相距 4px，按钮名称「查看模型状态：{提问摘要}」），打开「模型回退」弹窗：请求模型、实际模型与原因「会话所选的模型选项已被 Owner 移除，已在当前 Agent 允许范围内改用默认选项。」 | [PRD §8.2](../prd/PRD-agent-platform-M1.md#82-使用者选择)：Owner 删除会话当前使用的模型选项后，从下一条消息切到默认选项并说明变化；回退事件只有一种原因（`conversation-model-fallback.tsx`） |
| H4-11 | `/my-agents` 申请行 | 来源 tag 标准模板写模板名，自定义来源写「自定义 Agent · 平台交互入口」或「自定义 Agent · 自有交互入口」，与申请详情「来源」一致，不显示内部枚举；已撤回的申请 chip 为「已撤回」（gray） | `agentConversationSourceLabel()`；原导出稿直接显示 `custom` |
| H4-12 | 创建、修改申请「模型与推理」与「高级配置」 | 「模型与推理」只在来源为标准模板时出现：创建时依次为「Agent 默认 Relay Key」（帮助「只提交一次；保存后仅显示已设置状态，Key 不会回显。」）、「模型选项 N」（模型端点、模型、允许的推理档位）、默认模型、默认推理档位与「添加模型选项」，多于一个选项时才有「移除模型选项」；修改申请时先是「修改模型配置」复选框，勾选后才编辑模型。「高级配置」在所有来源下都有，默认收起（「展开高级配置 / 收起高级配置」），展开后为「环境变量」「Secret」两个小节 | [PRD §6.1](../prd/PRD-agent-platform-M1.md#61-创建申请)、[§8.1](../prd/PRD-agent-platform-M1.md#81-owner-配置)：标准模板提交一把 Agent 默认 Relay Key，不逐模型填写凭证；推理档位只显示中文名（`reasoningLevelLabel()`）；原导出稿为 Balanced / High / Max、模型凭证且没有高级配置 |
| H4-14 | 目录选择器（申请表单、Owner 配置、员工访问控制）首次聚焦 | 读取目录期间输入框重新获得焦点时不再发起读取，首次聚焦没有控制台错误 | 原导出稿读取中的重绘把焦点还给输入框并再次触发读取，形成递归（Maximum call stack size exceeded） |
| H4-15 | 申请详情确认撤回 | 回读为「已撤回」：审批「不再审批」、创建「不再创建」，下一步「此记录为只读历史。再次申请请从“我的 Agent”新建。」，页头操作移除，Toast「申请已撤回」 | [PRD §6.3](../prd/PRD-agent-platform-M1.md#63-管理状态)；原导出稿只关闭弹窗，申请仍为待审批 |
| H4-16 | Owner 配置「Agent 授权控制」（仅 Owner） | 配置卡首段、表单 fieldset 之前，与「共同 Owner」之间只有一条分隔线：目标类型「应用 / 用户」切换（选中为主按钮，`aria-pressed`），「应用 ID / 用户 ID」（名称带「：Agent 授权控制」）；应用为「授权管理 / 撤销管理 / 授权使用 / 撤销使用」，用户为「授权用户 API 使用 / 撤销用户 API 使用 / 授权用户 API 管理 / 撤销用户 API 管理」并附修订号说明；按钮都是 outline，未填目标时禁用；结果显示「服务端状态 / 授权版本 / 幂等重放」与 info 提示 | [PRD §7.3](../prd/PRD-agent-platform-M1.md#73-api-身份凭证与授权)、[工程 Spec §9.2](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#92-权限顺序)：API 与应用授权只由当前 Owner 治理，纯管理员视图不显示；页面唯一的主按钮是页脚保存 |
| H4-17 | Owner 配置「模型与凭证」（默认 Key 管理） | 说明后为「只列出默认 Key 可见、且模板支持的模型。勾选后可调整推理档位和默认模型选项。」与模型复选列表（「{端点} · {模型}」，勾选后缩进展开中文推理档位），下方为「默认模型选项」（「{端点} · {模型} · {档位}」）；没有模型端点下拉、「移除模型」与「模型可见范围」；「Agent 默认 Relay Key」的可用模型 tag 为「{模型} · 均衡/高」 | [PRD §8.1](../prd/PRD-agent-platform-M1.md#81-owner-配置)：模型清单由默认 Key 校验回读（`configuration-model-picker.tsx`） |
| H4-18 | Owner 配置「环境变量与 Secret」 | 环境变量名为下拉（模板允许的键，首项「请选择」），行尾 ghost「移除」（名称「移除：环境变量 N」，行内字段同样带「环境变量 N」，见 D2-58），下方「添加环境变量」；Secret 行为只读名称与状态和「替换 Secret」（名称「替换 Secret：{名称}」），下方「添加 Secret」 | [PRD §5.5](../prd/PRD-agent-platform-M1.md#55-环境变量与-secret)；同页不出现同名控件（D2-58） |
| H4-20 / H5-11 | 企微机器人扫码可用与扫码完成确认 | 可用时「扫码授权」打开面板「扫码授权 / 在新窗口中用企业微信扫码；扫码完成后在这里确认连接影响，平台再提交凭证并轮询验证结果。」，outline「打开扫码窗口」（等待时禁用为「等待扫码…」）与 ghost「关闭」；扫码后为「扫码已完成，确认后绑定 / 连接此机器人可能断开它在其他服务中的现有连接。确认后平台提交凭证并轮询验证结果。」、主按钮「确认并绑定」（自动聚焦）与「取消」，期间禁用手动字段与卡片操作；确认后焦点到卡片标题，验证完成、卡片变为「已连接」后仍在标题，取消清空 Bot ID 并回到「扫码授权」 | CK-09、#2911；扫码能力由服务端判定（W-24、W-25），确认前先说明连接影响（[PRD §10.2](../prd/PRD-agent-platform-M1.md#102-渠道绑定)）；标题为 `h3#wecom-bot-title`（`tabIndex=-1`），原导出稿标题没有 id，验证完成重绘后焦点落到 body |
| H4-21 | Owner 配置「停止 Agent」确认后 | 页头 chip「已停止」（gray），危险区移除，页脚保留「重启 Agent」，Toast「Agent 已停止，历史会话转为只读」 | 停止后的可用命令只剩重启与管理员停用（`agent-lifecycle-commands.ts`）；危险区卸载时焦点交给 h1（同 F3-11） |
| H4-23 / H5-04 | Owner 配置页头 Owner tag、`/my-agents?tab=owned` 已创建卡标题下的「Owner · …」 | 「Owner · 」后列出全部 Owner，以「、」分隔 | 与 Agent 详情的 Owner 投影一致；原导出稿只写第一名 Owner |
| H4-24 | `/admin/approvals` 审阅弹窗「审批判断」warn 提示 | 默认三角警示图标 | 与其余 warn 提示及 `Alert` 默认图标一致（E3-04）；原导出稿为圆形 i |
| H4-26 | `/skills` 搜索框 | 占位符「搜索名称、版本或来源」 | 目录投影只有名称、版本与来源可检索，没有用途与发布人 |
| H4-29 | `/eval` 说明 | notice 正文「不会自动读取个人会话；评测样本、输出与评分理由按评测用途单独授权。」 | [PRD §15.3](../prd/PRD-agent-platform-M1.md#153-数据与执行权限) |
| H5-01 / H5-02 | Agent 详情左栏「Agent 信息」的模型行；对话执行详情「模型」 | 平台交互入口的 Agent 列「模型范围」：每个模型选项为「{显示名} · {中文档位、…}」，多个选项以「；」分隔（没有时为「无可选择模型」），「默认推理档位」为中文名（没有时为「未提供」）；自有交互入口不列这两行。执行详情「模型」为「{显示名} · {中文档位}」，没有模型事实时为「未采集」 | 推理档位只显示中文名（H4-12，`reasoningLevelLabel()`），模型范围与申请详情（W-14）同格式；原导出稿模型范围只列名称，档位为 `Balanced` / `balanced` |
| H5-05 | 创建、修改申请「标准模板」下的模板就绪列表 | 与下拉相距 8px，列表下方不留外边距 | 原导出稿 `.template-readiness` 只设上外边距，`ul` 保留 UA 默认 14px 下外边距（同 D2-11） |
| H5-06 | 创建、修改申请「高级配置」的「展开高级配置 / 收起高级配置」（≤767px） | 保持 44px 单行按钮，说明在左侧换行 | 同 X-06（原导出稿按钮被挤成 96.7px 宽，折成两行、高 55.6px） |
| H5-07 | 目录选择器结果列表下的「清空搜索」 | 只在有关键词时显示，选中结果后关键词清空、不再显示；命中区至少 44px，字重 400 | 「清空搜索」位于结果列表之外，按 DESIGN.md 触达下限（`directory-fields.tsx`、`index.css` `.directory-clear`）；原导出稿 32px 且在关键词为空时常驻 |
| H5-08 / H5-10 / H5-12 | 禁用的表单控件：修改申请锁定的「来源」「标准模板」、企微机器人「扫码已完成，确认后绑定」与验证期间的 Bot ID / Secret、已停用 Agent 的 Owner 配置 | 输入框、下拉、文本框与目录选择器输入框不透明度 .5、`not-allowed`；目录 chip 的移除按钮同禁用按钮 .48；复选框为不透明度 .5 的公共复选框（勾选时 `--accent` 底与白色勾），选项文字不变淡 | 与公共 `Input`、`NativeSelect`、`Textarea`、`Checkbox` 的禁用态及 D2-07 一致；原导出稿只有 `.owner-config-fieldset:disabled` 下的部分控件变淡，原生下拉取 UA 默认 .7，复选框由 UA 画成灰底 |
| H5-13 | Owner 配置企微应用卡「EncodingAESKey」「应用 ID」 | 「EncodingAESKey」标签与输入框关联；「应用 ID」名称为「应用 ID：企微应用」 | 与「应用 ID：Agent 授权控制」（H4-16）区分（N-12）；原导出稿标签指向不存在的 id，输入框只能回落到占位符 |
| H5-15 | `/admin/agents`「运行状态」筛选 | 全部状态、创建中、可用、已停止、创建失败、已停用 | 列表按管理状态筛选（[PRD §6.3](../prd/PRD-agent-platform-M1.md#63-管理状态)），与 Y-09 的 `status=creation_failed` 同一组值；原导出稿为「就绪」（服务可用性）且缺「创建中」「已停用」 |
| H5-16 | `/admin/agents` 员工访问控制「禁用员工」 | 选中员工后可访问名称为「禁用员工：{姓名}」，未选员工时为「禁用员工」 | 取消或 Escape 关闭确认后的焦点目标（D2-59），与 `withObjectName` 一致 |
| H5-17 | 登录页（`login.html`）提交中的「显示密码」 | 与账号、密码一起禁用：不透明度 .48、`not-allowed` | 与公共 `Button` 禁用态一致；原导出稿按钮已禁用但没有禁用样式 |
| H5-18 | 公共状态卡的「重新登录」「重新加载…」 | 文字前分别为 16px lucide `LogIn`、`RefreshCw` | `page-state-card.tsx` 的默认 `RecoveryButton`；与运维页「重新读取观测状态」带刷新图标一致 |
| G5-09 | `/audit`、`/admin/audit`「结果」筛选 | 「全部结果」之后按审计结果列出：成功、已拒绝、失败、已受理、操作意图、已开始、已提交、等待中、处理中、已完成、已取消、结果待核实 | 选项取 `auditResultLabels`，同一控件内不出现同名选项（#3215 G5-09）；原导出稿为「成功 / 失败 / 待处理」示例 |
| J6-03 | `/my-agents`「申请 N / 已创建」Tab；`/skills/:id`「用途与内容 / 版本与变更」Tab | tablist（「我的 Agent 视图」「Skill 详情」）内为 tab：选中项 `aria-selected="true"`、`tabindex="0"`，`aria-controls` 指向唯一渲染的 tabpanel（`aria-labelledby` 指回该 Tab、`tabindex="0"`），未选中项 `tabindex="-1"`；左右方向键循环移动焦点并同时切换，Home / End 到首尾，Tab 键从选中项进入面板 | 公共 `Tabs`（Base UI，`activateOnFocus`）的语义与键盘行为（`my-agents-screen.tsx`、`skill-hub-version-screen.tsx`）；原导出稿「我的 Agent」为普通按钮、没有 Tab 语义，方向键不切换；「Skill 详情」只有 role 与 `aria-selected` |
| J6-04 | 目录选择器结果列表（≤767px：申请表单、修改申请、Owner 配置、员工访问控制） | 列表在选择框下方 6px；列表到提示行仍为 13px | `index.css` ≤767px 的 `.directory-menu{margin-top:6px}`；原导出稿列表是 `.field`（gap 7px 的 grid）的直接子项，叠加后为 13px |
| J6-05 | `/agents/:agentId/skills` 绑定卡标题后的版本胶囊 | 胶囊垂直居中（`vertical-align: middle`） | `index.css` `.quiet-pill`；原导出稿按基线对齐，1440 下比 Web 低 3.5px |

导出稿中以下内容仍与 Web 不同，不作为实现依据：

- 示例人员、模型、Agent 标识（如 `AG-042`）、计数、时间和 Skill 目录都是合成数据；Web 只显示服务端投影。
- 「原型状态」页的演示身份（系统管理员、Agent Owner、员工），以及运维观测、会话确认、回复与提交结果、
  已停止 Agent 的对话、浏览器卡终态等演示入口，只用于切换原型状态；Web 由会话角色和服务端结果决定，不提供切换。
- 原型的列表筛选、分页与刷新只演示控件位置，不改变合成列表；「查看失败清单」只预选「创建失败」示例。
  Web 由服务端查询结果决定。
- Skill 审核中「不能审核自己发布的版本」只在演示身份本人有待审版本时出现（例如先在「创建与发布」提交共享版本）。
- 「创建与发布 Skill」不演示项目内容修订号（CAS）冲突、文件数量与大小校验；上传到 `assets/` 的文件只保留在页面中。
  原型发布或导入后回到「我的 Skill」并只用 Toast 提示；Web 留在本页并就地显示结果。
- Skill 审阅弹窗的待审正文只演示已读取；读取中、读取失败、无权、版本已不在待审核、正文不可用与超过 64 KiB 截断的反馈以 Web 为准。
- 运维观测的「告警降级」计数是合成值，不代表真实观测数据。
- API 凭证页在原型中没有「签发个人凭证」分区，「收窄权限与有效期」只弹 Toast；「应用管理」分区只有应用摘要与签发、轮换入口，
  签发后也不显示「应用凭证结果」。签发个人凭证（权限范围、过期时间与一次性凭证提示）、行内收窄表单（C2-19）、
  打开既有应用、注册应用、凭证表单字段与结果以 Web 为准（H4-28）。
- 员工访问控制沿用原型的多选目录选择器；Web 一次只选一名员工，选中后收起结果。
- 原型的系统管理员演示身份不是「编程助手」的 Owner，Owner 配置因此按纯管理员视图显示；Owner 视图请切换演示身份，
  Owner 兼系统管理员与创建失败类别可从「原型状态」页的「创建失败类别」入口查看，示例失败类别为合成值。
  Web 由会话角色、Owner 关系与服务端失败类别投影决定。
- 浏览器操作记录的「操作步骤」与回复卡的思考过程正文是合成示例；Web 只显示时间线中实际回读的记录与模型提供的思考内容。
- 处理中发送的补充指令只加入时间线，不演示投递失败等结果；Owner 配置的停用与停止只改变原型的 Owner 配置与 Agent 管理，
  Agent 目录、详情与对话不随之变化，重试创建也不改变示例的创建失败状态。Web 以服务端结果与投影为准。
- 工作台「最近对话」卡底的「新会话会出现在这里」只是原型演示入口，Web 没有该按钮（H4-02）。
- 对话「会话上下文」里「可请求」浏览器卡的「查看操作请求」只演示切到等待确认；Web 的请求由 Agent 发起，该卡没有按钮（H4-08）。
- 原型的对话只有一份合成时间线：选择页「开始对话」进入所选 Agent 的新会话后，原示例会话不再显示（H4-04）；
  模型回退从「原型状态」页的「模型回退」入口在对话中查看（H4-10）。
- 修改申请的「模型与推理」只画未勾选的「修改模型配置」；勾选后的模型编辑（默认 Key 管理时先「检查可用模型」）、
  「添加模型选项」「添加环境变量」「添加 Secret」新增的行与字段校验以 Web 为准（H4-12、H4-18）。
- Owner 配置的「Agent 授权控制」只演示已授权或已撤销的回读结果，授权版本为合成值；拒绝、版本冲突与目标不可用等反馈以 Web 为准（H4-16）。
- 企微机器人扫码默认按不可用演示；扫码可用与扫码完成确认从「原型状态」页的「企微扫码授权可用」入口查看，扫码窗口与结果为模拟（H4-20）。
- 评测页的示例评测集、实验、卡底「原型示例：…」说明与可点击的「创建评测集」只演示结构；评测未接入，Web 各分段只显示空态，
  卡底说明为「评测集读写、真实运行、评分器和逐例复核尚未接入，接入前不能创建评测集，也不会显示示例结果。」，「创建评测集」禁用（H4-29）。

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

[#2863](https://github.com/AgoraIO-Extensions/agent-infra/issues/2863) 已在导出稿补画 `#ops`（F-12）：「系统管理」末尾的「运维观测」入口、
四个区块，以及已读取、未接入、读取中、不可用、无权限状态（演示入口在「原型状态」页）。本页设计以导出稿为准，
本节记录与之对应的结构、数据来源和状态条件。按 #2862 定论，`/ops` 保留在「系统管理」末尾
（[PRD §11.1](../prd/PRD-agent-platform-M1.md#111-页面)、[§14.2](../prd/PRD-agent-platform-M1.md#142-运维观测)），
样式沿用同类管理页页头与设计 `#my-agents` 已创建卡。

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
| `RadioGroup` / `RadioGroupItem` | 创建与发布 Skill 的发布范围单选卡（设计 `.scope-option`）；方向键切换，选项名称由文字 `aria-labelledby` 提供 |
| `Label` | 上述表单的可访问名称 |
| `Field` / `FieldError` | 字段标签与控件的容器；`FieldError` 为字段下方的校验错误（`role="alert"`），如审批驳回原因 |
| `Badge` | 状态 chip（`tone`，服务端状态经 `lib/status-tone.ts` 的 `statusTone()` 映射）与非状态标签（`variant="tag"`） |
| `Sidebar` / `Sheet` / `Breadcrumb` / `Avatar` | 桌面与移动导航、当前位置及登录身份 |
| `Tabs` | 我的申请与已创建 Agent 切换，Skill 详情的用途与版本 |
| `Dialog` / `ConfirmDialog` | 审批、Skill 审阅；撤回、生命周期、撤销凭证、撤销 Skill 版本、停用应用、禁用员工等确认；Skill 的审阅与确认用 `variant="skill"`（设计 `.skill-dialog`） |
| `Alert` / `Empty` | 设计 notice（`tone` 与默认图标）与空态；`Empty` 的直接子元素是均分高度的网格行，同一行的标题与说明用 `EmptyHeader` 包住 |
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

`Card`、`Collapsible`、`ConfirmDialog`、`DropdownMenu`、`RadioGroup`、`Spinner`、`StateCard`、`Toast` 与 `features/agent-mark.tsx` 为手写组件，不由 CLI 生成。
`Alert` 不设默认 role：首屏静态说明不设 role，异步结果用 `role="status"`，失败用 `role="alert"`；结果提示获得焦点、并已由 Toast 补充播报时（申请提交结果）不再设 role，避免同一结果播报两次。
`Badge` 只有 `variant="chip"`（状态，显式传 `tone`）与 `variant="tag"` 两种，不从 `data-status` 推导色调。
`Alert` 必须传 `tone`（`info`、`warn`、`danger`），没有旧变体名与缺省 tone 的兼容层。

普通导航保留 TanStack `Link` 或语义链接；需要控件外观时使用 `buttonVariants`，不改变链接角色。
站内路径一律用 `Link`（原生 `<a href="/...">` 会整页重新加载）；返回 / 取消链接的目标是当前地址的前缀时
加 `activeOptions={{ exact: true }}`，不让前缀匹配补上 `aria-current`。
读取失败后的「重新登录」「重新加载…」「重新读取」使用 `features/recovery-button.tsx` 的 `RecoveryButton`
（`PageStateCard` / `ReadFailureCard` 默认操作已内置）：请求中用 `aria-disabled` 保持可聚焦，失败后焦点留在按钮上；
恢复成功、按钮卸载后焦点移到页面 h1（需 `tabIndex={-1}`），没有可聚焦标题时落到 `#main-content`。
`Dialog` 关闭后焦点回到触发按钮；触发按钮当时被禁用、已卸载或随后随列表回读卸载时，焦点移到同一目标，不落到 body。
段落、列表、定义列表、表单和 fieldset 保持语义 HTML。
申请详情、Agent 详情和我的 Skill 使用索引路由，确保编辑、配置和创建子路径能渲染对应页面。

## 历史、身份与缺省状态

[#2925](https://github.com/AgoraIO-Extensions/agent-infra/issues/2925) 补充以下局部设计，
[#2863](https://github.com/AgoraIO-Extensions/agent-infra/issues/2863) 已把这些状态补画到导出稿，演示入口在「原型状态」页。
行为范围沿用 [PRD 对话与历史](../prd/PRD-agent-platform-M1.md#112-对话能力)及
[Runtime HLD](../architecture/HLD-agent-runtime-M1.md#8-消息事件与-sse-可靠性)的现有契约，不增加领域状态。

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
其后 eyebrow 保持 9px 间距；16px 只用于换行后的页头操作，操作组内的按钮不再叠加。触达尺寸仍采用已定的 44px。
Agent 详情的返回链接在窄屏保留 16px 上外边距（D-02）。#2863 已在导出稿按此缩小宽泛的窄屏 `.page-head .btn` 规则；
这是设计定版决定，不改变现有 Web 布局。

管理员 Agent 页（AA-01）依次排列页头、筛选、列表、分页、员工访问控制、应用凭证材料授权。
两个治理区在列表之后，以独立 FormSection 呈现，默认展开；标题采用 16px 正文字体，
说明、分隔线与控件沿公共分区规则。列表读取失败时只保留页头与失败提示，不展示治理区；
权限、pending、确认及结果反馈沿既有入口，不显示凭证材料值。
治理权限以 [PRD §2.3](../prd/PRD-agent-platform-M1.md#23-系统管理员)与
[PRD §7.3](../prd/PRD-agent-platform-M1.md#73-api-身份凭证与授权)为准。

列表行操作依次为「配置」、创建失败时的「重试」和管理员「停用」（[#3033](https://github.com/AgoraIO-Extensions/agent-infra/issues/3033)）：
停用先确认对象与后果，受理后重新读取列表，该行只剩「—」时焦点移到页面 h1。
系统管理员不在使用范围内时，配置页改读服务端管理员投影，只显示页头、权限边界与管理员操作，
返回链接指向 Agent 管理；读取边界见[工程 Spec §9.2](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#92-权限顺序)。

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
| 运维观测（[运维观测页](#运维观测页)） | `ops.spec.ts` | `ops` |

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
原型里的示例凭证、合成数据和演示入口不能作为生产能力移植。
测量通过仍须回读截图；PR 中记录绑定当前 head 的报告、视觉差异及人工结论。
