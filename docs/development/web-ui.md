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
| `index.html` | `902cf6afac71dd7f811174e2340b384f6ad30baa5b44ac6918bd1c4742e9b984` |
| `login.html` | `733d31e999296d2ed8e21f0237004427eac104cefd7c4c55cde6e3e87240641a` |
| `DESIGN.md` | `fa953264eafe4e0bd05adaa86387a9d90ad7af51d4e79f0a67620bfa31596d65` |
| `IMPLEMENTATION.md` | `ae3e592272933f65a0f7fc34363142a4471a724f7a75db76affe6ae12d640600` |
| `DESIGN-HANDOFF.md` | `3f2313d6d72bf3d7263d1e864730278217836ccdd5730d4b83460518bd2d3396` |
| `DESIGN-MANIFEST.json` | `7c3d0a82d0596030de48c7f0372dd4544e4bbd5b00071e8648966173b85a71a7` |

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
服务端批准的 `webPath`，再拼接并确认 origin 不变；Runtime 使用的 `mcpPath` 不作为浏览器授权入口。
对话时间线独立滚动，保留消息输入区及代码、表格的局部滚动。
短视口（高度不超过 600px）只压缩页头与间距，仍只有时间线一处滚动；执行详情是模态弹窗，关闭后焦点回到触发按钮。

对话结果文件预览属于会话文件卡的增量能力，不新增独立 `/preview` 页面：预览读取沿 File Grant
取得一次性 Blob，文本、图片、PDF 和统一 diff 在卡片弹窗内展示，静态 HTML 使用隔离 iframe；
无法预览的类型继续提供下载。该能力不改变 Builder/独立开发服务预览仍不属于 M1 的结论。

原型中的示例人员、模型、就绪提示和演示操作不作为生产数据或新增能力。
申请、审批、配置、生命周期及审计继续复用现有组件、请求和权限校验。

导出稿的回写边界（[#3270](https://github.com/AgoraIO-Extensions/agent-infra/issues/3270)）：

- 必须画出：每个页面的主要业务状态，以及 main 上有独立视觉结构的组件与状态，例如对话页的
  [Skill 控制文件](#对话-skill-控制文件)、[会话文件与附件行](#对话会话文件附件)、
  [回答内 sandbox 图片与文件卡、回复卡「结果文件」列表与产物预览弹窗](#对话结果文件与产物预览)、
  [命令 / Skill 调用回执](#命令与-skill-调用回执)、用户消息发送失败与回复执行失败，侧栏「退出登录」，
  Owner 配置的「镜像升级」、默认 Key 校验中与替换时重新选择模型，修改申请的默认 Key 模型编辑器。
  导出稿在「原型状态」页或对应路由的演示切换里提供入口。
- 只画代表态：同一结构只换文案或色调的变体画一个代表态，其余在下方「导出稿中以下内容仍与 Web 不同」按类登记。
- 以 Web 为准（明确豁免，[#3294](https://github.com/AgoraIO-Extensions/agent-infra/issues/3294) N9-3-10）：
  API 凭证页的签发个人凭证、一次性凭证提示与行内收窄表单，应用管理的打开既有应用、注册应用、「停用应用」确认与「应用凭证结果」，
  以及 Skill 发布与导入后的就地结果。它们的结构由 [PRD §7.3](../prd/PRD-agent-platform-M1.md#73-api-身份凭证与授权)、
  [§11.5](../prd/PRD-agent-platform-M1.md#115-skill-hub) 与工程 Spec [§8.1](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#81-浏览器与用户应用-api)、
  [§11.6](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#116-skill-hub版本绑定与-worker-装配)
  定义，交互以 Web 为准，导出稿不逐一补画；导出稿已有的代表态（个人凭证列表与撤销、应用摘要与签发 / 轮换入口、
  创建与发布 Skill 表单）保持与 main 一致。差异只在下方「导出稿中以下内容仍与 Web 不同」登记一处（H4-28）。
- 不必逐一画出：只用公共组件（`PageStateCard`、`LoadingLine`、`Alert`、`FieldError`、`RecoveryButton`、`Empty`）
  呈现的读取中、读取失败、空、无权限与字段错误状态；它们以[组件与调用方](#组件与调用方)的规则为准，
  在「导出稿中以下内容仍与 Web 不同」按类登记一次。

### 已回写导出设计的结论

以下结论已在 #2862、#2863、#2903、#2996 与 #2830 终验（#3037–#3041、#3046、#3052，第二轮 #3127–#3130，第三轮 #3160、#3161，第四轮 #3179、#3180，第五轮 #3215、#3216，第六轮 #3235、#3236，第七轮 #3242、#3243，第八轮 #3267–#3270，第九轮 #3291–#3294，第十轮 #3327–#3330）确认，
并由 [#2863](https://github.com/AgoraIO-Extensions/agent-infra/issues/2863)、
[#3107](https://github.com/AgoraIO-Extensions/agent-infra/issues/3107)、
[#3130](https://github.com/AgoraIO-Extensions/agent-infra/issues/3130)、
[#3161](https://github.com/AgoraIO-Extensions/agent-infra/issues/3161)、
[#3180](https://github.com/AgoraIO-Extensions/agent-infra/issues/3180)、
[#3216](https://github.com/AgoraIO-Extensions/agent-infra/issues/3216)、
[#3236](https://github.com/AgoraIO-Extensions/agent-infra/issues/3236)、
[#3243](https://github.com/AgoraIO-Extensions/agent-infra/issues/3243)、
[#3270](https://github.com/AgoraIO-Extensions/agent-infra/issues/3270)、
[#3294](https://github.com/AgoraIO-Extensions/agent-infra/issues/3294) 与
[#3330](https://github.com/AgoraIO-Extensions/agent-infra/issues/3330) 回写本版导出稿；实现与验收以这里为准：

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
| Y-04 / H4-19 / H4-25 / H5-14 / H5-19 / J6-01 / J6-02 / L7-01 / K7-01 | 全站图标：侧栏、顶栏、页头与按钮、提示、空态、卡头、头像、Skill 标记、对话工具栏、登录页 | 导出稿图标全部取自 lucide-react 1.41.0，与 Web 一一对应：`iconPaths` 每个 key 与登录页内联 svg 逐段取自 `apps/web` 依赖的源码，尺寸与 Web 同处一致（侧栏 17px，按钮 16px，提示 17px，空态 28px，Skill 标记 20px，窄屏「打开导航」16px，发送 15px，模型与思考入口的下拉箭头 12px）。对照（key → lucide）：home `House`、bot `Bot`、message `MessageCircle`、layers `Layers`、package `Package`、plus `Plus`、clipboard `ClipboardMinus`、check `Check`、list `List`、external `ExternalLink`、menu `Menu`、search `Search`、arrow `ArrowRight`、chevron `ChevronRight`、chevronLeft `ChevronLeft`、chevronDown `ChevronDown`、back `ArrowLeft`、settings `Settings`、history `History`、refresh `RefreshCw`、rotate `RotateCcw`、stop `Square`、send `Send`、eye `Eye`、key `KeyRound`、shield `Shield`、shieldCheck `ShieldCheck`、activity `Activity`、flask `FlaskConical`、info `Info`、alert `TriangleAlert`、x `X`、user `UserRound`、scan `Scan`、ban `Ban`、login `LogIn`；登录页过期提示为 `Clock`，密码隐藏 / 显示时为 `Eye` / `EyeOff`。同一位置 Web 用不同图标时按调用点区分：Skill Hub 目录与「我创建的」为 `Layers`、「已安装」为 `Package`、Skill 审核行为 `Shield`；Skill 空态读取失败为 `TriangleAlert`、待审核为空为 `Shield`、其余为 `Search`；Owner 配置「权限边界」为 `ShieldCheck`，其余盾牌为 `Shield`。线宽导出稿统一为 1.8（Web 侧栏与 Agent 详情区头为 1.8，其余为 lucide 默认 2，16px 下约差 0.13px）；原生下拉的箭头沿用 CSS 渐变，与 Web `NativeSelect` 相同 | 全站同一语义只用一种 lucide 字形（G4-06、G4-10）；逐个调用点对照 main 同处的 lucide 组件，1440 与 390 下墨迹差小于 1px（#3243）；人像统一为 `UserRound`：对话用户头像与浏览器接管卡头、Agent 详情 Owner 区头同一字形（K7-01）。此前逐轮只替换被点名的 key（`scan`、`settings`、`refresh`、`bot`、`shield`、`activity`、`clipboard`、`stop`）；L7-01 一次换完其余自绘或近似的 key（`home`、`message`、`layers`、`plus`、`check`、`list`、`external`、`menu`、`search`、`arrow`、`back`、`history`、`send`、`eye`、`info`、`alert`、`x`、`user`、`ban`），新增 `package`、`chevronDown`，删除没有调用点的 `filter`、`play`、`pause`、`more`；原导出稿窄屏「打开导航」为 19px，发送图标被按钮样式放大到 16px，Skill 标记按示例 Skill 取不同图标，下拉箭头为旋转 90° 的 chevron-right |
| Y-09 | 工作台「待处理」管理员行 | 系统管理员另有一行「运行状态 / N 个 Agent 创建失败 / 查看失败清单」，进入 `/admin/agents?status=creation_failed`；Owner 行按导出稿对齐 | 系统管理员可代替 Owner 重试创建失败的 Agent（[PRD §2.3](../prd/PRD-agent-platform-M1.md#23-系统管理员)、[§6.3](../prd/PRD-agent-platform-M1.md#63-管理状态)） |
| Z-02 | 对话 composer 的发送按钮 | 草稿为空且没有选中命令或 Skill 时禁用 | 消息命令 `MessageCommandRequestV1.text` 必须非空；禁用比无反馈的点击更清楚 |
| Z-04 | 已完成回答的状态行 | 「已完成 · 重新生成 · 查看执行详情」：已完成、失败与已停止的回答都可重新生成；不显示「n 步」 | [PRD §11.2](../prd/PRD-agent-platform-M1.md#112-对话能力)：重新生成基于同一条用户消息产生新回答，服务端只要求会话没有活跃回复。会话投影没有步数，过程摘要在执行详情 |
| Z-06 | 对话页个人历史面板 | 列表下保留 ghost「此 Agent 的全部历史」与「最近对话」切换；展开时聚焦面板，之后 Agent 数据后台更新不移动焦点（D2-59，N13-07） | 面板默认是跨 Agent 的最近对话，切换后才是当前 Agent 的分页历史（[PRD §11.2](../prd/PRD-agent-platform-M1.md#112-对话能力) 查看历史会话、[§12.2](../prd/PRD-agent-platform-M1.md#122-会话历史)） |
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
| D2-55 / H4-06 / H5-03 / O9-08 | 对话页回答上方「思考过程」 | 有思考内容时显示，默认收起；回复处理中且尚无正文时默认展开，正文出现或刷新后收起（处理中回复卡已有「图片待发送」「文件待发送」等正文时同样收起）；停止回复后，已收到的思考过程仍在已停止的回答上方并收起；摘要 44px、12px muted，「展开 / 收起」11px `--accent-ink`；正文 13px / 1.7 muted。执行详情页脚为「这里展示可审计的执行事实，不包含思考过程；模型提供的思考过程显示在回答上方。」 | [PRD §11.2](../prd/PRD-agent-platform-M1.md#112-对话能力)：思考过程显示在回答上方并可折叠（#3012）；原导出稿停止回复后丢掉已收到的思考过程（H5-03），处理中（待发送）回复卡已有正文时思考过程仍展开（O9-08） |
| D2-56 / F3-03 | 对话页短视口（高度不超过 600px） | 页头只留 h1（44px），隐藏 eyebrow 与副标题，折叠条省略「按需查看」；会话上下文、时间线、会话文件与输入框之间统一 6px；仍只有时间线滚动 | 见[OpenDesign 视觉版本](#opendesign-视觉版本)短视口规则；原导出稿短视口仍用常规间距（10 / 0 / 18px） |
| D2-57 / F3-07 | 申请表单多服务 YAML 文本框（`#app-manifest`） | 可访问名称「多服务资源 YAML 内容」，占位符三行；最小高 224px，等宽 14px / 20px | 与上方文件输入「多服务资源 YAML」区分（[#3119](https://github.com/AgoraIO-Extensions/agent-infra/issues/3119)）；尺寸同 `agent-application-form.tsx`，原导出稿沿用公共文本框的 110px、15px |
| D2-58（D2-01、D2-02、D2-08、D2-10、D2-16、D2-20）/ O9-18 | 同页重复的行内与卡内操作 | 可访问名称为「{可见文字}：{对象名}」：工作台最近对话、待处理、可用 Agent 与我的申请，我的 Agent 已创建卡，企微卡片（「验证并绑定：企微机器人」等），审批「审阅」，Agent 管理行操作，审计「详情：{事件} · {时间}」，Skill Hub 与我的 Skill 行操作；Agent 目录为「查看 {名称} 详情」；回复卡用提问摘要（超过 20 字截断，重复时按出现顺序加「（第 N 次）」）；申请表单可重复的行（模型选项、环境变量、Secret）内的字段、推理档位复选框与「移除」按钮以所在行 legend 为对象名（「模型端点：模型选项 2」「均衡：模型选项 1」「移除 Secret：Secret 1」）；按模型勾选的推理档位复选框（Owner 配置「模型与凭证」、修改申请的 Key 候选）以所属模型为对象名（「均衡：Relay · Internal · gpt-5」）；Owner 配置「环境变量与 Secret」的环境变量行以行序号为对象名（「环境变量名：环境变量 1」「值：环境变量 1」「移除：环境变量 1」，两行选了同一变量名时仍可区分），Secret 行的只读字段以 Secret 名称为对象名（「Secret 名称：RELEASE_KEY」「当前状态：RELEASE_KEY」）；`/skills/manage/new` 配套文件卡的目录、文件名、文件内容与移除以文件路径为对象名（「目录：scripts/run.sh」「移除文件：assets/logo.png」），同路径（含都未命名）按出现顺序加「（第 N 次）」，可见标签不变（N8-3-06）；卡片的分组名称（sr-only legend）同样用这个标签：「配套文件 {序号}：{路径}（第 N 次）」（O9-18） | 可访问性：同页不出现同名控件，与 `withObjectName`、`distinctObjectNames` 一致（N-12）；原导出稿上传两份 assets 后同样有「目录」「文件名」同名，已按此回写（#3270）；原导出稿 legend 仍用原始路径（`skill-project-content-editor.tsx` 用 `fileLabels`，O9-18） |
| D2-59（D2-17、D2-19、D2-24、D2-25、D2-28、D2-34、D2-36、D2-38、D2-39、D2-43、D2-48、D2-50、D2-51）/ F3-13 / I6-01 / L7-02 / K7-02 / K7-03 / N8-3-02 / N8-3-04 / N8-3-09 / N8-1-09 / N8-2-01 / O8-02 / O8-06 / N9-2-03 / N9-3-02 / N9-3-04 / N9-3-06 / N10-2-01 / N10-2-02 / N11-02 / N11-03 / O9-01 / O9-02 / O9-12 / O9-16 / N10-1-01 / N10-3-02 / O10-01 / O10-02 / O10-03 / N12-01 / N12-03 / N13-03 / N13-04 / N13-05 / N13-06 / N13-07 / N13-08 / N13-10 / N14-07 / N14-08 / N14-09 / N14-10 / N14-11 / N14-12 | 演示动作完成后的焦点 | 弹窗（含 Skill 弹窗）打开时聚焦弹窗容器，只含一个输入框的表单弹窗（「替换 Secret」「替换 Agent 默认 Relay Key」）聚焦该输入框；扫码面板打开后焦点留在「扫码授权」；确认解绑企微后到卡片标题；Skill 绑定或更换固定版本后到该绑定卡标题，解除后到下一张卡标题，没有时到 h1；审批驳回空原因时到「驳回原因」，Escape 关闭后回到「审阅：{申请名}」；申请提交或重新提交后到「申请已提交：待审批。」提示（H4-13）；确认撤回申请后到 h1（H4-15）；Owner 配置确认停止 Agent 后到 h1（H4-21）；确认禁用员工后到「员工访问控制」，取消或 Escape 关闭禁用确认回到「禁用员工：{姓名}」；审计详情打开后到「审计详情」区域，Escape 或「关闭」回到触发按钮；页头刷新（「刷新 Agent 列表」「刷新运维状态」「刷新审计记录」）与「刷新审计详情」读取中保持可聚焦（`aria-disabled`），完成后焦点留在刷新按钮，详情刷新后 Escape 仍关闭详情并回到触发按钮；页头刷新失败、刷新按钮随页头工具收起时到 h1，详情重读失败或「重试详情」恢复后到「审计详情」区域；加入我的库进行中为可聚焦的「正在校验包…」（`aria-disabled`），完成后到「配置 Agent 绑定」，撤销版本后到 h1；Relay Key 保存后到「替换 Key」，撤销后到 Relay Key 输入框（H4-27）；确认撤销 API 凭证后到该行凭证标识，取消或 Escape 关闭撤销确认回到「撤销：{凭证}」；「停用应用」取消或 Escape 关闭确认回到「停用应用：{应用名}」，确认后焦点仍在它上面、停用中保持可聚焦（`aria-disabled`），停用成功后到应用名标题（N9-3-06）；签发或轮换应用凭证后到「应用凭证结果」；停止回复后到该回复卡的「重新生成」；浏览器卡「停止操作」受理后到该回复卡的「正在停止」，停止确认后到浏览器卡「查看操作记录」（没有时同停止回复）；企微机器人、企微应用手动「验证并绑定」验证期间保持可聚焦（`aria-disabled`），结束（已连接或验证失败）后焦点仍在按钮上时到卡片标题，「取消配置」后同样到卡片标题，「等待扫码…」期间保持可聚焦；Owner 配置「保存配置」后到「没有需要保存的变更。」；发送、补充指令、「重新发送」与「核实原请求」受理后焦点已落到 body 时回到输入框；「重新生成」请求中保持可聚焦（`aria-disabled`），受理后到原回答位置处理中回复卡的「停止回复」（没有时到输入框，N8-1-09）；导出稿暂无的会话附件「重试」「移除附件」与发送后转为访问失效的焦点见[对话会话文件附件](#对话会话文件附件)、[对话访问失效](#对话访问失效)；浏览器卡其余命令处理中按钮保持可聚焦（`aria-disabled`），受理并回读到下一阶段后到新卡的下一步操作：允许后到「接管浏览器」（下一阶段为执行中时到「停止操作」），接管后到「交还给 Agent」，交还后到「停止操作」，拒绝与停止接管后到「查看操作记录」（都没有时到输入框，再没有时到 h1）；确认发送命令或 Skill 后、「准备重新发送」后到输入框（O8-02、O8-05）；替换默认 Key 确认后焦点回到「替换默认 Key」，校验中它保持 `aria-disabled` 并留住焦点（O8-06）；「升级镜像」受理后到「新镜像引用」，「检查可用模型」检查中与完成后留在按钮上；产物预览弹窗关闭后回到触发的「预览」「预览图片：…」；Skill 控制文件见[对话 Skill 控制文件](#对话-skill-控制文件)；停用 Agent 与重试创建见 D2-22、D2-12；重绘不收起已展开的折叠条，焦点留在折叠条内的同一控件；对话页历史面板只在展开（由关到开，或在最近对话与全部历史之间切换）或首次读到 Agent 时聚焦面板，之后 Agent 数据后台更新（回到标签页重读、「更新中」轮询转就绪）不移动焦点，输入框与历史链接上的焦点和继续键入的字都保留（N13-07）；读取失败后的恢复按钮（审计列表「重试」、Relay Key「重新读取状态」、API 凭证与应用「重新加载」、「重新读取目录」、对话页「刷新 Agent 状态」「重新连接」，以及读取 401 的「重新登录」：Skill Hub、Relay Key、API 凭证与应用管理、Agent 管理，N9-3-04）重读进行中保持可聚焦，恢复后到页面 h1（应用管理到「应用管理」标题，执行详情与产物预览的重新读取到弹窗，模型设置「重试」保存中与成功后到模型入口，命令菜单「重试」到输入框），仍失败时回到按钮（「重新连接」的仍失败指自动重连用尽、连接中断提示重新出现，N14-11）；「刷新 Agent 状态」读取中横幅显示「正在刷新 Agent 状态…」，读取失败时横幅内一行「暂时无法刷新 Agent 状态，请稍后重试。」（`role="alert"`）直到下一次读到 Agent，回到标签页等后台重读不显示（N14-12）；恢复焦点只交接一次：交给恢复目标后，或用户按下指针、按键、点击（含点主区空白处使焦点到 `#main-content`）之后不再代管，之后的重读与重绘不再把焦点拉回标题、不滚动页面；本次恢复请求有了结果后，同一个恢复按钮因后台重读再次出现（成功或失败）都不取回焦点、不滚动，「仍失败时回到按钮」只指本次恢复请求本身失败（N13-04）；「离开该页面」只指 pathname 变化或恢复按钮随导航卸载，触发后离开（含重读进行中浏览器后退到上一页）不代管，新页面的焦点同普通导航；同一页面只改查询串（筛选、分页、Tab、`?view=`、`?applicationId=` 后退等）或壳层状态卡跨路由保留时代管继续，结果按同页规则，查询串代表另一个资源时（Skill 编辑器的 `?project=`）由调用方声明（N13-03）；持有焦点的控件（含未按下的恢复按钮、筛选控件、分页按钮）因非用户发起的重绘（后台重读、自动重连）卸载或变为原生禁用时，焦点交给同页的下一个合理目标（另一个分页按钮、页面 h1 或 `#main-content`），不落到 body、不滚动页面，审计分页按钮因回到标签页的后台重读读到末页等变为禁用时交给另一个分页按钮、两个都不可用时到 h1（N13-05、N13-06）；页面与公共组件没有更精确的目标时由应用壳层的焦点丢失兜底接住：主内容区或弹窗里持有焦点的控件（内联失败提示、整页「申请暂不可用」、审批队列替换掉的列表、搜索框与审阅弹窗，随后台重读变为原生禁用的下拉）丢失焦点后交给仍打开的所在弹窗，否则页面 h1（不可聚焦时 `#main-content`），确认弹窗随所在分区卸载、finalFocus 目标已不在时同样如此；用户点空白处、浏览器后退离开页面、直接打开页面时不抢焦点（N14-07、N14-08、N14-09）；详情区域里未按下的「刷新审计详情」随后台重读卸载时交给详情区域，详情区域也卸载时到 h1（N14-10）（以上按[回写边界](#opendesign-视觉版本)不逐一画出，见[组件与调用方](#组件与调用方)，N12-03）；Skill 项目内容保存冲突后的「重新读取内容」重读进行中同样保持可聚焦（「正在重新读取…」），读到内容后到 SKILL.md 文本框，仍失败时到读取失败区的「重新读取」（按[回写边界](#opendesign-视觉版本)导出稿不画，见[管理与设置页的缺失状态](#管理与设置页的缺失状态)，N11-03）；「重新登录」（含工作台与 Agent 目录）确认会话已失效、整页换成登录页后，焦点同主动退出交给登录页（见[组件与调用方](#组件与调用方)，N10-1-01；导出稿的「重新登录」整页跳转到 `login.html?reason=expired&from=relogin`，代表同一文档内换成登录页：显示过期提示、焦点到「公司账号」，直接打开 `login.html`（含 `reason=expired`）不抢焦点，#3330 回写）；读取中整页换成读取态、按钮随之卸载时，焦点先到页面 h1（运维观测「重新读取观测状态」、Skill Hub 目录「重新读取」到「Skill Hub」，O9-16、O10-02），页面标题不可聚焦时到 `#main-content`；侧栏「退出登录」进行中与失败后焦点留在入口上，侧栏「我的 Connection」（新窗口外链）之后焦点同样留在入口上，窄屏导航 Sheet 保持打开、不重放滑入动画（O9-01、O10-01）；无匹配空态「清除筛选」后到搜索框（Agent 管理、Agent 目录、Skill Hub）；Agent 管理前端分页翻到首页或末页、触发的按钮随之禁用时焦点交给另一个分页按钮（同 `/audit`），都不可用时到 h1，新的一页随之滚入视口：表格到分页条放得下时整段可见，放不下时表格顶端贴着吸顶顶栏、让出 16px（N9-3-02）；「关闭一次性凭证提示」后到「签发个人凭证」；创建 Skill 项目进入新项目后先到「项目信息」标题、读到内容后到 SKILL.md 文本框；签发个人凭证后到「已签发个人 API 凭证」（幂等重放与签发失败到提示本身），签发应用凭证失败到失败提示，二者都滚入视口；审批决定失败时焦点留在触发按钮、失败提示滚入弹窗可视区（N8-3-01）；Connection 安装「开始安装 / 查询状态 / 重新开始」是同一个按钮，准备与查询期间可聚焦；以下几项按[回写边界](#opendesign-视觉版本)导出稿不画（#3270），以[申请与 Owner 配置的补充状态](#申请与-owner-配置的补充状态)为准：移除 Owner 配置的环境变量行、申请表单的模型选项 / 环境变量 / Secret 行后，焦点到同一位置下一行的「移除」，没有下一行时到上一行的「移除」，该行没有「移除」或没有行时到「添加环境变量 / 添加模型选项 / 添加 Secret」；申请整表校验失败与非校验类提交失败（503、500、不可重试的 409，N11-02）后到页面顶部的提交失败提示，提示随之滚入视口（修改申请入口身份不可用，或修改申请的模板已移除、不可申请时同样到顶部提示，N9-2-03、N10-2-01、N10-2-02；创建申请所选模板不可申请时到「标准模板」下拉；提交被拦下后部署选项重读使修改申请的模板拦截提示随模板恢复收起，或创建申请握着焦点的「标准模板」下拉随重读禁用时，焦点交给页面标题，不可聚焦时到 `#main-content`，不落到 body、不滚动页面，N12-01；部署选项读取失败时标准模板申请被拦下、没有可操作的出错字段，焦点到「重新加载部署选项」（不可重试时到部署状态说明），展开的下拉随重读禁用时弹层收起、焦点同样交给页面标题，N13-08、N13-10），多服务 YAML 未填写或语法错误时到「多服务资源 YAML 内容」；镜像升级失败后焦点留在「升级镜像」；Owner 配置保存冲突后「重新读取可用模型」读取中保持可聚焦，读到后到模型选择器的第一个模型（没有选择器时到「保存配置」），读取失败时留在按钮上；以上焦点目标与 Tab、「跳至主要内容」的目标滚入视口时停在吸顶顶栏之下，见[组件与调用方](#组件与调用方)的吸顶顶栏让位（N10-3-02；导出稿已同步根样式，O10-03） | 与 Web 一致：动作完成后焦点在触发按钮、结果标题或 h1，不因整页重绘落到 body（N-06）；单输入框弹窗的初始焦点同 `secret-replace-dialog.tsx`、`default-relay-key-dialog.tsx`；保存配置同 `agent-configuration-screen.tsx`；手动绑定、取消配置与等待扫码同 `wecom-bot-setup.tsx`、`wecom-app-setup.tsx`，发送、补充指令、「重新发送」与「核实原请求」同 `active-conversation.tsx`（K7-02、K7-03）；动作进行中触发按钮保持可聚焦，见[组件与调用方](#组件与调用方) |
| F3-02 | 对话页处理中与停止后的回复卡 | 每条提问只有一张回复卡：发送后处理中卡跟在该提问之后，重新生成时在原回答的位置显示处理中卡；停止后在同一位置显示已停止的回答，重新生成被停止时作为该回答的新版本（版本行 x/y）；处理中卡的「查看执行详情」带所答提问的摘要 | 与 Web 一致：回复按提问归组（`conversation-screen-messages.tsx`），同页不出现同名控件（D2-58）；原导出稿处理中卡追加在时间线末尾，与上一条回答指向同一提问 |
| #3377 | 对话页处理中的回复卡与失败回答 | meta 行右侧为 spinner 加阶段（排队中、准备会话、执行中、调用工具：{展示名}、模型重试，role=status）和 11px muted「已用 N 秒」（每秒刷新，不放进 role=status）；回复执行失败的状态行原因取 V2 会话读取的失败分类说明（如「执行失败 · 附件无法读取，请重新发送附件」），旧服务端没有分类时按错误码映射。按[回写边界](#opendesign-视觉版本)导出稿不画 | [PRD §11.2](../prd/PRD-agent-platform-M1.md#112-对话能力)：处理期间显示当前阶段和实时耗时，阶段只反映实际发生的处理过程；[PRD §10.5](../prd/PRD-agent-platform-M1.md#105-执行中消息与失败提示)：失败按同一组原因分类提示。阶段与企微进度帧使用同一 Contract 推导（`executionProgressPhaseV1`），分类说明由 Core 给出（[工程 Spec §16.1.1](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1611-用户可见失败分类)） |
| F3-04 | 对话页浏览器卡「工具调用失败」 | 与「已停止」相同：danger 24% 混色边框、红色图标、red「已停止」chip | 失败与停止都需要重新核实页面（Z-10），Web 按已停止阶段呈现（`browser-card.ts`）；原导出稿 `failed` 阶段漏挂 danger 样式 |
| F3-06 | 对话页处理中的 composer | 输入框仍可编辑；Runtime 支持补充指令时发送按钮为「发送补充指令」，否则为「发送」，消息进入排队；草稿为空时禁用；「命令 / Skill」入口禁用（opacity .48、not-allowed）。排队消息在该条用户消息上显示「排队中（第 N 位），前面还有 N−1 条消息」与「撤回」，撤回、排队超时与取消只说明结果（排队超时另给「准备重新发送」） | [PRD §10.5](../prd/PRD-agent-platform-M1.md#105-执行中消息与失败提示)：补充指令优先，其次有界排队，满了才提示繁忙；[PRD §11.2](../prd/PRD-agent-platform-M1.md#112-对话能力)；[§11.3](../prd/PRD-agent-platform-M1.md#113-原生命令与已安装-skill)：活跃回复期间不再启动新的命令任务或 Skill |
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
| H4-18 / O9-14 | Owner 配置「环境变量与 Secret」 | 标准模板的环境变量名为下拉（模板允许的键，首项「请选择」），自定义 Agent 没有模板限定的名称，为文本输入框，行尾 ghost「移除」（名称「移除：环境变量 N」，行内字段同样带「环境变量 N」，见 D2-58），下方「添加环境变量」；Secret 行为只读名称与状态和「替换 Secret」（名称「替换 Secret：{名称}」），下方「添加 Secret」 | [PRD §5.5](../prd/PRD-agent-platform-M1.md#55-环境变量与-secret)；同页不出现同名控件（D2-58）；只有模板限定名称时才用下拉（`configuration-secrets-section.tsx` `allowedEnvironmentKeys`），原导出稿自定义 Agent 同样画成下拉（O9-14） |
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
| H5-08 / H5-10 / H5-12 / I6-02 | 禁用的表单控件：修改申请锁定的「来源」「标准模板」、企微机器人「扫码已完成，确认后绑定」与验证期间的 Bot ID / Secret、已停用 Agent 的 Owner 配置（含企微机器人「我已知悉可能断开其他连接」、企微应用「我已知悉可能影响现有回调」） | 输入框、下拉、文本框与目录选择器输入框不透明度 .5、`not-allowed`；目录 chip 的移除按钮同禁用按钮 .48；复选框为不透明度 .5 的公共复选框（勾选时 `--accent` 底与白色勾），选项文字不变淡 | 与公共 `Input`、`NativeSelect`、`Textarea`、`Checkbox` 的禁用态及 D2-07 一致；公共 `Checkbox` 不受 `<fieldset disabled>` 影响，企微确认复选框显式接收表单禁用（`wecom-bot-setup.tsx`、`wecom-app-setup.tsx`，I6-02）；原导出稿只有 `.owner-config-fieldset:disabled` 下的部分控件变淡，原生下拉取 UA 默认 .7，复选框由 UA 画成灰底 |
| H5-13 | Owner 配置企微应用卡「EncodingAESKey」「应用 ID」 | 「EncodingAESKey」标签与输入框关联；「应用 ID」名称为「应用 ID：企微应用」 | 与「应用 ID：Agent 授权控制」（H4-16）区分（N-12）；原导出稿标签指向不存在的 id，输入框只能回落到占位符 |
| H5-15 | `/admin/agents`「运行状态」筛选 | 全部状态、创建中、可用、已停止、创建失败、已停用 | 列表按管理状态筛选（[PRD §6.3](../prd/PRD-agent-platform-M1.md#63-管理状态)），与 Y-09 的 `status=creation_failed` 同一组值；原导出稿为「就绪」（服务可用性）且缺「创建中」「已停用」 |
| H5-16 | `/admin/agents` 员工访问控制「禁用员工」 | 选中员工后可访问名称为「禁用员工：{姓名}」，未选员工时为「禁用员工」 | 取消或 Escape 关闭确认后的焦点目标（D2-59），与 `withObjectName` 一致 |
| H5-17 / N8-3-11 | 登录页（`login.html`）提交中的「显示密码」与「正在登录…」 | 「显示密码」与账号、密码一起禁用：不透明度 .48、`not-allowed`；「正在登录…」是可聚焦的禁用（`aria-disabled`，#3242 K7-02），仍按导出稿为不透明度 .65、光标 `wait`；导出稿提交按钮同样改为 `aria-disabled`，提交中焦点留在按钮上（#3270） | 与公共 `Button` 禁用态一致；原导出稿按钮已禁用但没有禁用样式。提交按钮按 login.html `.submit:is(:disabled,[aria-disabled="true"])`，`index.css` 的 `.login-submit` 同时命中 `:disabled` 与 `[aria-disabled="true"]` |
| H5-18 | 公共状态卡的「重新登录」「重新加载…」 | 文字前分别为 16px lucide `LogIn`、`RefreshCw` | `page-state-card.tsx` 的默认 `RecoveryButton`；与运维页「重新读取观测状态」带刷新图标一致 |
| G5-09 | `/audit`、`/admin/audit`「结果」筛选 | 「全部结果」之后按审计结果列出：成功、已拒绝、失败、已受理、操作意图、已开始、已提交、等待中、处理中、已完成、已取消、结果待核实 | 选项取 `auditResultLabels`，同一控件内不出现同名选项（#3215 G5-09）；原导出稿为「成功 / 失败 / 待处理」示例 |
| J6-03 / K7-04 | `/my-agents`「申请 N / 已创建」Tab；`/skills/:id`「用途与内容 / 版本与变更」Tab | tablist（「我的 Agent 视图」「Skill 详情」）内为 tab：选中项 `aria-selected="true"`、`tabindex="0"`，`aria-controls` 指向唯一渲染的 tabpanel（`aria-labelledby` 指回该 Tab、`tabindex="0"`），未选中项 `tabindex="-1"`；左右方向键循环移动焦点并同时切换，Home / End 到首尾，Tab 键从选中项进入面板；「Skill 详情」的 tabpanel 本身就是左侧卡片，键盘焦点环沿卡片 14px 圆角 | 公共 `Tabs`（Base UI，`activateOnFocus`）的语义与键盘行为（`my-agents-screen.tsx`、`skill-hub-version-screen.tsx`）；原导出稿「我的 Agent」为普通按钮、没有 Tab 语义，方向键不切换；「Skill 详情」只有 role 与 `aria-selected`；`/eval` 分段面板同样取所包空态的 14px 圆角，焦点环不露出直角（K7-04） |
| J6-04 | 目录选择器结果列表（≤767px：申请表单、修改申请、Owner 配置、员工访问控制） | 列表在选择框下方 6px；列表到提示行仍为 13px | `index.css` ≤767px 的 `.directory-menu{margin-top:6px}`；原导出稿列表是 `.field`（gap 7px 的 grid）的直接子项，叠加后为 13px |
| J6-05 | `/agents/:agentId/skills` 绑定卡标题后的版本胶囊 | 胶囊垂直居中（`vertical-align: middle`） | `index.css` `.quiet-pill`；原导出稿按基线对齐，1440 下比 Web 低 3.5px |
| L7-03 | `/skills/:id`「版本与变更」Tab 的版本行 | 每行只有「v{版本} + 状态」与右侧「正在查看 / 查看版本」，不显示版本说明，也不显示「有新版本可升级」；「查看版本」可访问名称为「查看版本：v{版本}」 | Skill 版本投影没有说明字段，详情页不读取绑定（W-35、V-17）；`skill-hub-version-screen.tsx` 用 `withObjectName`；原导出稿每行下有版本说明，绑定旧版本时列表下方另有升级提示 |
| L7-04 | `/my-agents` 申请列表与「已创建」卡 | 申请行在列表「我的申请」内、行标题为 h2；已创建卡在列表「我管理的 Agent」内、卡片标题为 h2；可见字号、字重与位置不变 | `my-agents-screen.tsx` 的标题层级（页面只有 h1）；原导出稿申请行标题为 strong、已创建卡标题为 h3（跳过 h2），都不在列表内 |
| O8-01 / N10-1-02 | 对话已选 Skill 卡下的错误行、命令菜单「目录读取失败」、Skill 控制文件的选择错误、模型设置不可重试失败行 | 12px / 1.6 `--danger-ink`，与表单 `FieldError` 同色；≤767px 错误行内缩 8px（同 #3259）。模型设置失败行「模型选项已变化，请刷新模型清单后重新选择。」（`role="status"`）在输入框与工具栏之间、上距 4px，左右内缩同错误行（≥768px 12px，≤767px 8px），选择回到已保存值、焦点留在模型入口 | main `.composer-zone .capability-inline-alert` 与 `.capability-menu .capability-inline-alert`；原导出稿 `.cap-error` 为 `--danger`，菜单失败为 `--muted`。模型设置失败行（`.model-preference-failure`）导出稿没有，同一结构只换文案，按代表态核对（#3327 N10-1-02） |
| O8-02 / O9-05 | 命令 / Skill 调用回执 | 见[命令与 Skill 调用回执](#命令与-skill-调用回执)：时间线末尾的独立块，不生成用户消息与回复卡，没有「本地合成执行记录」；执行中与结果待核实时回执之后是「停止回复」；「调用详情」打开执行详情，「核实原操作」只回读原执行；确认发送后焦点回到输入框 | 调用不写会话消息（`active-conversation.tsx` 的 trailing 回执）；原导出稿追加用户消息与回复卡、回执在回复卡内，确认发送后焦点落到 body；结果待核实时去掉了「停止回复」（`stopControl` 只按 `isTerminal` 判断，O9-05） |
| O8-03 / O9-06 | 对话「会话文件」 | 见[对话会话文件与附件](#对话会话文件附件)：只列本页上传的输入附件，「添加附件」与限制说明在面板顶部，图片附件有 40px 缩略图；折叠条的「会话文件」「按需查看」与展开 / 收起提示不收缩、保持单行，只有摘要文字换行（「会话上下文」相同） | 结果文件在回复卡「结果文件」列表与回答内文件卡（O8-05）；原导出稿同时列结果文件、「添加文件」在列表下方，并有「原型示例」说明；390 下标题与提示被挤成两行（`.chat-disclosure-summary` 的 `strong` 与提示列 `flex: none`，O9-06） |
| O8-05 | 对话页与侧栏的导出稿缺失状态 | 已补画 [Skill 控制文件](#对话-skill-控制文件)、[会话文件与附件](#对话会话文件附件)、[回答内 sandbox 图片与文件卡、「结果文件」列表与产物预览弹窗](#对话结果文件与产物预览)；用户消息发送失败为消息内 danger 提示（不设 role）与 outline「准备重新发送」，只把原文放回输入框并提示「请确认草稿后手动发送；不会自动提交。」，焦点到输入框；回复执行失败的状态行为「执行失败 · {原因} · 可重新生成 · 重新生成 · 查看执行详情」；只读命令带参数时错误行为「这项只读命令不需要额外参数，请清空输入框后再发送。」，服务端拒绝时保留所选项并写明原因（如「所选版本已变化，请重新选择。内容没有降级为普通消息。」）；侧栏当前用户卡下方为「退出登录」，见[侧栏退出登录](#侧栏退出登录) | `conversation-screen-messages.tsx`、`conversation-capability-picker.ts`、`conversation-capability-lifecycle.ts`、`logout-action.tsx`、`login-page.tsx`；演示入口在「原型状态」页 |
| O8-06 / O9-15 | Owner 配置「Agent 默认 Relay Key」校验与替换弹窗 | 校验中为 info 提示「正在校验默认 Key」（`role="status"`）与 amber「校验中」，保留 `aria-disabled` 的「替换默认 Key」，焦点留在它上面直到完成，完成后 Toast「Agent 默认 Relay Key 已替换」；校验中禁用「模型与凭证」的选择器。替换弹窗先「正在校验…」：新 Key 覆盖当前模型时关闭弹窗交给分区；不能调用部分当前模型时为 warn「新的 Key 不能调用部分当前模型」（说明里的模型与选择器同一「{端点} · {模型}」标签，如「Relay · Internal · GPT-6.1」）并在弹窗内重新选择（选好前「校验并替换」`aria-disabled`，替换中「正在替换…」；该 warn 已列出会被移除的模型，弹窗内的选择器不再显示「保存后会移除这些模型」，N9-2-05）；没有可用模型时为 warn「新的 Key 没有此模板可用的模型」；失败为 danger「默认 Key 未替换」，焦点回到输入框；校验或替换进行中弹窗不能关闭 | `configuration-default-relay-key-section.tsx`、`default-relay-key-dialog.tsx`、`configuration-model-section.tsx`（RK2-08）；原导出稿校验中隐藏「替换默认 Key」，确认后焦点落到 body |
| O8-07 | 企微手动绑定认证失败 | 机器人「绑定未完成，请检查凭证后重试。」，应用「绑定未完成，请检查应用凭证后重试。」；失败不弹 Toast，由错误行的 `role="alert"` 播报；成功仍为 Toast「企微机器人已连接」「企微应用已连接」 | `wecom-bot-setup.tsx`、`wecom-app-setup.tsx`；原导出稿两者都是「认证失败，请检查凭证后重试。」并弹 Toast「企微凭证验证失败」 |
| O8-08 | `/agents/:agentId/skills` 同步失败的绑定卡 | 固定说明「内容同步失败，这个版本不会在对话中提供。」（12px / 1.5 `--danger-ink`），不按失败原因区分 | 绑定投影的失败说明为固定文案（`agent-skill-binding.ts`）；原导出稿按原因写「包校验未完成，继续使用前需要重新同步。」 |
| O8-09 / O9-17 | `/skills/manage/new`「导入固定来源」字段错误 | 错误放在各自字段下（12px / 1.5 `--danger-ink`），名称与固定版本引用都无效时两条一起显示，出错字段 `aria-invalid`：未聚焦时为 `--danger` 边框与 1px 20% `--danger` 外环，聚焦时边框仍为 `--accent`（F3-15，导出稿其余字段错误相同），焦点到第一个出错字段，输入时清除该字段的错误 | 同 V-19、D2-21 的字段错误规则（`skill-hub-management-screen.tsx`）；原导出稿只在按钮后显示第一条，且被 `.form-section > p` 改成 muted；出错字段没有 danger 边框（公共 `Input` 的 `aria-invalid:border-destructive aria-invalid:ring-1`，O9-17） |
| O9-01 / O10-01 | 窄屏导航 Sheet 内的「退出登录」与「我的 Connection」 | 进行中与失败时 Sheet 保持打开，停在打开位置、不收起也不重放滑入动画：进行中焦点留在可聚焦的禁用「正在退出…」，失败后留在「退出登录」，「退出登录失败，请重试。」在入口下方可见；「我的 Connection」在新窗口打开，Sheet 不收起，焦点留在入口上；桌面侧栏相同 | 见[侧栏退出登录](#侧栏退出登录)（`logout-action.tsx`，#3267 N8-1-01）；Sheet 不随页面状态卸载，外链不关闭 Sheet（`application-shell.tsx`）；原导出稿重绘时收起 Sheet，焦点落到 body，失败提示渲染在已收起的 Sheet 里（O9-01）；#3294 回写后每次重绘抽屉先收回再滑入（约 215ms，失败时再来一次），侧栏「我的 Connection」仍收起 Sheet、焦点落到 body（O10-01） |
| O9-03 / O9-04 | Agent 详情：自有交互入口与「运行与渠道」服务状态 | 自有交互入口的 Agent 不显示「每个用户都有独立会话」与「个人历史」分区，其余信息区、入口状态与「打开 Agent」不变；服务状态说明只写用户看到的行为：可用且就绪「可以发送消息并获得回复」，不可用「历史只读，可稍后重试」，其余服务状态「历史只读，暂时不能发送消息」，Agent 不在可用管理状态时「历史只读，当前不能发送消息」；服务状态 chip 与状态行同一色调 | `agent-detail-screen.tsx`（`!selfManaged`、`serviceDescription`）：自有交互入口不在平台会话中对话；[PRD §6.4](../prd/PRD-agent-platform-M1.md#64-服务可用性) 按用户看到的行为说明服务可用性；原导出稿一律写「Runtime 健康检查已通过」（技术组件名），chip 恒为 green |
| O9-07 / O9-09 / O9-11 | 对话「结果文件」列表、产物预览读取失败、用户消息发送失败提示 | 回答内图片读取中（「正在加载图片：…」）已计为在回答中显示，列表该行只写 12px muted「已在回答中显示」；预览读取失败的 danger 提示内，文字与「重新读取」相距 10px；消息内 danger 提示的文字与公共 `Alert` 描述同为 13px / 1.65 | `conversation-screen-messages.tsx` `ResultFileList`（`inAnswer` 在占位渲染时已计入）、`conversation-artifact-preview.tsx`、公共 `AlertDescription`；原导出稿读取中给「预览」「下载」，按钮贴着失败文字，提示文字被 `.message-body p` 改成 14px |
| O9-10 | 公共 `Dialog` 的弹窗容器（预览、执行详情、审阅与确认弹窗） | 打开后焦点在弹窗容器上，容器不画焦点环；弹窗内控件的焦点环不变 | 容器只是打开时的初始焦点落点，不是可操作控件（`DialogContent` `outline-none`）；原导出稿全局 `:focus-visible` 给 `.modal` 画 2px accent 环 |
| N9-1-01 | 对话页输入框上方的说明行（代表态「请确认草稿后手动发送；不会自动提交。」） | 14px / 20px、400、正文前景色，左缘与输入框对齐，与输入框相距 10px（短视口 6px）；其余说明行见[对话页状态说明行](#对话页状态说明行) | `active-conversation.tsx` 的说明行为 `text-sm`，`.chat-thread` 子项间距 10px（短视口 6px，D2-56），#3293 统一；原导出稿 `.chat-draft-notice` 行高 23.1px、与输入框相距 22px（#3294 核对） |
| N9-3-06 | API 凭证页「应用管理」的「停用应用」 | 可访问名称「停用应用：{应用名}」（停用中为「正在停用…：{应用名}」），可见文字仍为「停用应用」、outline 不带图标；确认弹窗、停用中与停用后的焦点按[回写边界](#opendesign-视觉版本)的豁免以 Web 为准（D2-59、[管理与设置页的缺失状态](#管理与设置页的缺失状态)） | `application-management-screen.tsx` 的 `withObjectName`；原导出稿名称只有「停用应用」（#3294 核对 #3292） |
| N10-3-02 / O10-03 | 全站吸顶顶栏让位（根样式与顶栏内控件） | 根滚动容器 `scroll-padding-top` 为顶栏高度加 16px（88px，1440 与 390 相同），顶栏内控件的 `scroll-margin` 上 -88px、下 +88px：程序聚焦、Tab 与 `scrollIntoView` 的目标停在顶栏下 16px，页面滚动后聚焦「打开导航」不滚动页面；元素不另设 `scroll-margin-top` | 见[组件与调用方](#组件与调用方)的吸顶顶栏让位（`index.css` 的 `html` 与 `:where(.platform-topbar *)`，WCAG 2.2 SC 2.4.11），导出稿为 `html` 与 `:where(.topbar *)`；原导出稿根样式没有 `scroll-padding-top`，390 下「创建项目」空名提交与 Shift+Tab 后「包名称」停在视口顶边、被 72px 顶栏盖住，申请表单「Agent 名称」两档视口相同 |
| #3270（边界）/ O9-13 | Owner 配置「镜像升级」、修改申请的默认 Key 模型编辑器 | 自定义 Agent 的 Owner 配置没有「模型与凭证」与「Agent 默认 Relay Key」，在「环境变量与 Secret」之后为「镜像升级」：分区说明「当前来源：{镜像引用}」（13px）、「新镜像引用」与 outline「升级镜像」（输入为空时禁用，升级中「升级中…」`aria-disabled`、输入框禁用，页脚不变；受理后 Toast「已提交镜像升级请求」，焦点到输入框）；自有交互入口的 Agent 另不显示渠道与 Skill。修改申请勾选「修改模型配置」后为「Agent 默认 Relay Key」与 outline「检查可用模型」（未输入时禁用，检查中「正在检查…」`aria-disabled`）及 14px 帮助，失败为 danger「Key 校验失败或暂时无法读取可用模型，请检查后重试。」；检查后为与 Owner 配置同一个选择器（H4-17：13px 说明「只列出该 Key 可见、且模板支持的模型。勾选后可调整推理档位和默认模型选项。」、模型复选与中文推理档位、单个「默认模型选项」），没有候选时为 warn「该 Key 没有此模板可用的模型」；提交被拦下时 Key 字段下为公共字段错误（「请输入 Agent 默认 Relay Key。」「请先点击「检查可用模型」并选好模型…」「该 Key 没有此模板可用的模型，请换一个 Key 后重新检查。」「请在下方选好模型…」），焦点到 Key 输入框；导出稿 Key 含 `fail` 时演示校验失败、含 `empty` 时演示没有可用模型；勾选或取消模型、推理档位后焦点留在该复选框，没有控制台错误 | `configuration-image-section.tsx`、`agent-configuration-screen.tsx`、`application-keyless-model-editor.tsx`、`configuration-model-picker.tsx`（#3121、#3268 N8-2-05、N8-2-06）；导出稿原来没有这两个结构；原导出稿按含点号的模型 key 拼 `#id` 选择器，每次勾选都抛页面错误（O9-13） |

导出稿中以下内容仍与 Web 不同，不作为实现依据：

- 结构语义以 Web 为准：分区地标（以标题命名的 region）、步骤条、审批进度与同步阶段的列表语义、以标题命名的 article，导出稿不逐页补齐；可见的标题级别按 Web 回写（L7-04、L7-05）。
- 示例人员、模型、Agent 标识（如 `AG-042`）、计数、时间和 Skill 目录都是合成数据；Web 只显示服务端投影。
- 「原型状态」页的演示身份（系统管理员、Agent Owner、员工），以及运维观测、会话确认、回复与提交结果、
  已停止 Agent 的对话、浏览器卡终态、发送与执行失败、会话文件、回答内图片与结果文件、产物预览、命令与 Skill 交互（含控制文件）、
  替换默认 Key、自定义 Agent 镜像升级、修改申请的模型、退出登录失败等演示入口，只用于切换原型状态；Web 由会话角色和服务端结果决定，不提供切换。
- 原型的列表筛选、分页与刷新只演示控件位置，不改变合成列表；「查看失败清单」只预选「创建失败」示例。
  Web 由服务端查询结果决定。Agent 管理的合成列表只有一页（「第 1 / 1 页」，两个分页按钮禁用，与 Web 不足一页时相同），
  翻页后的焦点与滚动以 D2-59 为准（N9-3-02）。
- Skill 审核中「不能审核自己发布的版本」只在演示身份本人有待审版本时出现（例如先在「创建与发布」提交共享版本）。
- 「创建与发布 Skill」不演示项目内容修订号（CAS）冲突、文件数量与大小校验；上传到 `assets/` 的文件只保留在页面中。
- Skill 审阅弹窗的待审正文只演示已读取；读取中、读取失败、无权、版本已不在待审核、正文不可用与超过 64 KiB 截断的反馈以 Web 为准。
- 运维观测的「告警降级」计数是合成值，不代表真实观测数据。
- API 凭证与 Skill 发布、导入的就地结果按[回写边界](#opendesign-视觉版本)的豁免以 Web 为准（H4-28、#3294 N9-3-10）：
  原型 API 凭证页没有「签发个人凭证」分区与「已签发个人 API 凭证」一次性凭证提示，「收窄权限与有效期」只弹 Toast；
  「应用管理」分区只有应用摘要与签发、轮换入口，没有「打开既有应用」「注册一个应用」表单，签发或轮换后也不显示「应用凭证结果」，
  「停用应用」（名称「停用应用：{应用名}」，N9-3-06）只弹 Toast；
  「创建与发布 Skill」发布或导入后回到「我的 Skill」并只用 Toast 提示。签发个人凭证（权限范围、过期时间、一次性凭证提示、
  幂等重放与签发失败）、行内收窄表单（C2-19，含权限选项）、打开既有应用、注册应用、凭证表单字段、签发与轮换结果及失败、
  「停用应用」确认弹窗与停用中、停用后的焦点（N9-3-06），以及发布 / 导入后留在本页的就地结果（「查看版本详情」「已提交审核」）以 Web 为准，见[管理与设置页的缺失状态](#管理与设置页的缺失状态)与 D2-59。
- 员工访问控制沿用原型的多选目录选择器；Web 一次只选一名员工，选中后收起结果。
- 原型的系统管理员演示身份不是「编程助手」的 Owner，Owner 配置因此按纯管理员视图显示；Owner 视图请切换演示身份，
  Owner 兼系统管理员与创建失败类别可从「原型状态」页的「创建失败类别」入口查看，示例失败类别为合成值。
  Web 由会话角色、Owner 关系与服务端失败类别投影决定。
- 浏览器操作记录的「操作步骤」与回复卡的思考过程正文是合成示例；Web 只显示时间线中实际回读的记录与模型提供的思考内容。
- 处理中发送的补充指令只加入时间线，不演示投递失败等结果；Owner 配置的停用与停止只改变原型的 Owner 配置与 Agent 管理，
  Agent 目录、详情与对话不随之变化，重试创建也不改变示例的创建失败状态。Web 以服务端结果与投影为准。
- 工作台「最近对话」卡底的「新会话会出现在这里」只是原型演示入口，Web 没有该按钮（H4-02）。
- 导出稿没有审批决定失败、审计分页读取中、Skill 文件数量与合计校验、Relay Key 状态未知、员工打开系统管理页、
  Skill Hub、设置页与 Agent 管理读取 401、两个分区同时读取失败、Skill 审核页目录读取失败与项目内容保存冲突后的重新读取，
  见[管理与设置页的缺失状态](#管理与设置页的缺失状态)（按回写边界不逐一画出；无权限与 401 的代表态是「原型状态」页公共状态的「未授权」「登录」卡，
  以及运维观测的「未授权」）。原型的员工演示身份只隐藏侧栏「系统管理」，直接打开这些路由仍显示管理员视图；
  个人凭证签发结果、收窄表单与「停用应用」确认见上方 API 凭证一条。
- 导出稿用 hash 路由切换页面，没有「跳至主要内容」页内锚点，以 Web 为准；吸顶顶栏让位已按[组件与调用方](#组件与调用方)同步到导出稿根样式（#3330 O10-03）。
- 发送后转为访问失效的状态只用公共组件呈现，导出稿不画，见[对话访问失效](#对话访问失效)。
- 对话页状态说明行只画「请确认草稿后手动发送；不会自动提交。」代表态；会话准备中 / 更新中、原执行结果待核实（含行内「核实原执行状态」）、自动重新连接与「原模型选项已移除」说明行以[对话页状态说明行](#对话页状态说明行)为准。
- 对话「会话上下文」里「可请求」浏览器卡的「查看操作请求」只演示切到等待确认；Web 的请求由 Agent 发起，该卡没有按钮（H4-08）。
- 原型的对话只有一份合成时间线：选择页「开始对话」进入所选 Agent 的新会话后，原示例会话不再显示（H4-04）；
  模型回退从「原型状态」页的「模型回退」入口在对话中查看（H4-10）。
- 修改申请勾选「修改模型配置」后只画默认 Key 管理的模型编辑器（#3270 行），Key 含 `fail` 时演示校验失败；
  「添加模型选项」「添加环境变量」「添加 Secret」新增的行与字段校验以 Web 为准（H4-12、H4-18）。
- Owner 配置不跟踪表单改动：进入页面时「保存配置」可点，页脚为合成的「最近保存：…」；保存后显示「没有需要保存的变更。」并禁用保存，再改动字段、目录选择或点「添加…」后恢复可保存。Web 由表单是否有改动决定。
- Owner 配置的「Agent 授权控制」只演示已授权或已撤销的回读结果，授权版本为合成值；拒绝、版本冲突与目标不可用等反馈以 Web 为准（H4-16）。
- 企微机器人扫码默认按不可用演示；扫码可用与扫码完成确认从「原型状态」页的「企微扫码授权可用」入口查看，扫码窗口与结果为模拟（H4-20）。
- 评测页的示例评测集、实验、卡底「原型示例：…」说明与可点击的「创建评测集」只演示结构；评测未接入，Web 各分段只显示空态，
  卡底说明为「评测集读写、真实运行、评分器和逐例复核尚未接入，接入前不能创建评测集，也不会显示示例结果。」，「创建评测集」禁用（H4-29）。
- 只用公共组件呈现的状态按[回写边界](#opendesign-视觉版本)不逐一画出，以[组件与调用方](#组件与调用方)的规则为准：
  - 读取中：`LoadingLine` / `PageLoadingState`，如我的 Agent 两个 Tab、申请详情、Owner 配置与已保存 Key 的可用模型、
    Agent 的 Skill、创建审批与 Agent 管理列表、Skill 审核队列、审计列表、个人 Relay Key 与 Skill 编辑内容；
  - 读取失败：`PageStateCard` / `ReadFailureCard` 与 `RecoveryButton`，或 danger `Alert` 加重试，如最近对话、
    申请详情与修改申请、Agent 的 Skill 绑定与可绑定版本、审计列表与详情、API 凭证列表、个人 Relay Key、目录名称批量读取；
  - 部分省略：warn `Alert`（`role="status"`），如工作台与对话页「最近对话」里渠道资格暂时无法确认的 Agent，
    文案为「{N} 个 Agent 的对话暂时无法显示，其他对话不受影响。」。其余对话照常列出，不显示 Agent ID，
    也不按读取失败处理（[工程 Spec §14.1](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#141-web)）；
  - 空：`Empty`，如 Agent 目录、我的 Agent 两个 Tab、Agent 管理与创建审批无匹配、审计无记录、Skill Hub 与我的库为空；
  - 无权限：`PageStateCard`（`unauthorized`）或共用「无法访问」卡（P-01），如非 Owner 打开 Owner 配置或 Agent 的 Skill、
    员工打开系统管理页与平台审计、发送后访问权限失效；
  - 字段错误：`FieldError`（12px `--danger-ink`，出错字段 `aria-invalid` 并获得焦点，同 D2-21、D2-29），
    如申请表单与多服务 YAML 的本地校验、环境变量重名、添加 Secret、共同 Owner 为空、审计时间范围、个人 Relay Key，
    以及模型选择器的选择问题（「至少选择一个模型。」等，修改申请里为 polite）。
- 同一结构只换文案或色调的变体只画代表态，其余以 Web 为准：命令 / Skill 的服务端拒绝原因（导出稿画「所选版本已变化」）、
  模型设置不可重试失败行（同 O8-01 错误行）、
  附件与 Skill 控制文件的失败原因、用户消息的投递失败原因、创建失败类别（导出稿画健康检查未通过）、
  企微卡片的提交、轮询与解绑提示、模型选择器改选后的「保存后 / 提交后会移除这些模型」、镜像升级失败、Agent 详情的生命周期与浏览器能力提示、申请表单模板就绪状态与提交失败（含所选模板不可申请、修改申请的模板不可用，#3328；非校验类提交失败，#3351；拦截后部署选项重读的同步与没有可申请的标准模板，#3364；部署选项读取失败，#3389）、
  写操作失败提示（撤回、停止与重启、保存配置、授权控制、审批决定、Skill 审核、加入或移出我的库、发布与导入、凭证签发与收窄）。
- 动作进行中的按钮文案（「批准中…」「保存中…」「正在提交…」等）与 `aria-disabled` 以 Web 为准（[组件与调用方](#组件与调用方)、D2-59）。
- 长名称、长提问、长文件名的截断与换行，以及「显示更多」「加载更多」的分批显示以 Web 为准。
- 结果文件、回答内文件卡与产物预览弹窗的「下载」在原型中只弹 Toast，PDF 预览为示例页面；Skill 控制文件「添加文本文件」只在本页模拟上传；
  替换默认 Key 的校验结果由「原型状态」页的入口决定（默认按新 Key 覆盖当前模型）。Web 以服务端结果为准。
- 只在开发构建出现的界面（顶栏「本地开发 · 测试身份」、登录页「选择开发测试身份」与登录入口未配置）导出稿不画。
- Owner 配置「模型与凭证」只画默认 Key 托管；部署目录管理模型时的「当前模型 / 当前默认」摘要与「替换模型配置」以 Web 为准，
  其中的模型选择器同 H4-17。

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

### 申请与 Owner 配置的补充状态

[#3268](https://github.com/AgoraIO-Extensions/agent-infra/issues/3268)（#2830 终验第八轮）收敛了导出稿没有画过的以下状态。其中「默认 Key 没有可用模型」
「默认 Key 管理模型的选择」与「镜像升级进行中」已在 #3270 回写导出稿，其余只用公共组件或已画结构的变体呈现，
按[回写边界](#opendesign-视觉版本)不逐一画出；以本节为准（`agent-application-form.tsx`、`application-keyless-model-editor.tsx`、`agent-configuration-screen.tsx`、
`configuration-image-section.tsx`、`agent-creation-failure.tsx`、`agent-skill-binding-screen.tsx`）。
[#3291](https://github.com/AgoraIO-Extensions/agent-infra/issues/3291)（第九轮）补充了「部署没有标准模板」「修改申请入口身份不可用」与修改申请选择器字段错误的播报方式，
并写明镜像升级进行中的生命周期按钮；前两者是模板就绪列表与服务端校验失败的变体，选择器字段错误用公共 `FieldError`，
按[回写边界](#opendesign-视觉版本)不逐一画出（#3294 核对：导出稿镜像升级进行中的生命周期按钮与替换 Key 弹窗已与本节一致）。
[#3328](https://github.com/AgoraIO-Extensions/agent-infra/issues/3328)（第十轮）补充了「所选模板不可申请」与「修改申请的模板不可用」，
二者是模板就绪列表与提交失败提示的变体，只用公共 `Alert`、`FieldError`，按[回写边界](#opendesign-视觉版本)不逐一画出（#3330 核对：导出稿就绪列表只画全部「可申请」的代表态，没有提交失败提示），以本节为准。
[#3351](https://github.com/AgoraIO-Extensions/agent-infra/issues/3351)（第十一轮）补充了「非校验类提交失败」的焦点与位置，并让验证过期的就绪原因不再引导刷新；
二者同样是提交失败提示与模板就绪列表的变体，按[回写边界](#opendesign-视觉版本)不逐一画出，以本节为准。
[#3364](https://github.com/AgoraIO-Extensions/agent-infra/issues/3364)（第十二轮）补充了提交被模板拦下后部署选项重读、就绪状态再变化时顶部提示与字段错误的同步，以及「没有可申请的标准模板」；
同样只是提交失败提示、字段错误与模板就绪列表的变体，按[回写边界](#opendesign-视觉版本)不逐一画出，以本节为准。
[#3389](https://github.com/AgoraIO-Extensions/agent-infra/issues/3389)（第十三轮）补充了「部署选项读取失败」时就绪列表、「标准模板」下拉、提交拦截、结果页与焦点的同一个下一步；
同样只是部署状态说明、字段错误与模板就绪列表的变体，按[回写边界](#opendesign-视觉版本)不逐一画出，以本节为准。

- 字段级错误：申请表单与修改申请（含 Key 编辑器的拦截错误）、目录选择器（申请表单、Owner 配置、员工访问控制）、
  企微应用逐字段错误与 Owner 配置的名称校验都用公共 `FieldError`（12px / 1.5、`--danger-ink`、上距 6px），只在出错时渲染，
  控件设 `aria-invalid` 并经 `aria-describedby` 指向它。目录选择器用 assertive live region 播报，申请表单用 polite
  （焦点已移到出错字段；修改申请里默认 Key 模型选择器的选择问题同样 polite，不与 Key 字段的拦截错误互相打断，
  Owner 配置「模型与凭证」的同一选择器仍为 `role="alert"`），企微应用逐字段错误不另行播报，由卡片错误行统一说明。
- 企微卡片错误行：企微机器人、企微应用卡片内的校验、验证与解除绑定失败按导出稿 `.wecom-channel-error`，
  为单行 12px / 1.6 红字（`--danger` 78% 混 `--fg`），无边框、无图标，距上方 10px，`role="alert"`。
- 申请表单「Connection 授权」分区（#3406）：嵌在「基本信息」里，标题为 h3，字体、字号、字重与行高同 `FormSection` 子级标题
  （16px / 620 / 1.35 正文字体），不用 `.management-content h2` 的展示字体，标题大纲为「基本信息」之下的一级（#3433 N15-06）。

| 状态 | 条件 | 呈现 |
| --- | --- | --- |
| 整表校验失败 | 创建或修改申请返回 `INVALID_REQUEST` | 只在页面顶部显示一条 danger 提示（`role="alert"`，`tabIndex=-1`）「申请内容未通过服务端校验，请检查字段后重试。」，焦点移到它；表单内不重复，表单不作为焦点目标；未修改时再次提交被拦下 |
| 非校验类提交失败 | 创建或修改申请返回 `DEPENDENCY_UNAVAILABLE`（503）、`INTERNAL_ERROR` 或其他可重试错误（含未知的 500），或不可重试的错误（如 409） | 同整表校验失败，只在页面顶部显示一条 danger 提示（`role="alert"`，`tabIndex=-1`）：依赖不可用与内部错误为「申请提交失败，部署依赖暂不可用，请稍后重试。」，其余可重试错误为「申请提交失败，非敏感内容已保留。请重新填写 Secret 或模型凭证后再提交。」，不可重试为「申请已变更或当前不可用，请刷新页面后核对。」。提交进行中页底的「提交审批」「修改申请」「修改并重新提交」为可聚焦的「正在提交…」（`aria-disabled`）；失败返回后提示滚入视口（让出吸顶顶栏，见[组件与调用方](#组件与调用方)）并接过焦点，不留在页底按钮上（同 API 凭证页签发失败，N8-3-09）；页脚不另放说明，也没有 Toast。可以直接再次提交，焦点留在提交按钮上，不被抢回旧提示（N11-02） |
| 修改申请入口身份不可用 | 修改「自定义 Agent · 自有交互入口 · 由平台校验」的申请，服务端以 `ACTION_UNAVAILABLE` 拒绝（部署未启用平台身份入口） | 已有申请不能更改入口身份，不引导重试：顶部同一条 danger 提示（`role="alert"`，`tabIndex=-1`）为「当前部署不支持此申请的入口身份校验，请新建申请。」，焦点移到它（只读的「入口身份校验」不作为焦点目标）；该字段下保留字段错误「当前部署未启用平台身份入口。已有申请不能更改入口身份校验，请新建申请并选择「由自有入口校验」。」；未修改时再次提交被拦下，焦点回到顶部提示。创建申请时顶部为整表校验失败的通用文案，字段错误提示改选，焦点到入口身份下拉 |
| 部署没有标准模板 | 部署配置没有登记标准模板（`templates` 为空），来源为标准模板 | 「标准模板」下拉禁用（占位「选择标准模板」）；就绪列表仍按 [PRD §4](../prd/PRD-agent-platform-M1.md#4-标准模板) 列出 Codex、Claude、OpenCode、Pi，均为「{显示名}：尚未登记，请联系平台管理员。」，不显示模板 ID；提交时「标准模板」下为字段错误「当前部署没有可用的标准模板或模型选项，请联系管理员配置后重试。」 |
| 部署选项读取失败 | 部署配置读取失败或服务端返回部署不可用（`status` 为 `unavailable`；页面打开时或会话内重读，含回到标签页、窗口重新聚焦触发的重读），来源为标准模板；创建与修改申请 | 页面顶部为部署状态说明（`role="status"`）「部署选项需要刷新后才能提交标准模板申请。」与「重新加载部署选项」，不可重试时为「部署选项暂不可用，请联系管理员。」、没有按钮。就绪列表仍按 [PRD §4](../prd/PRD-agent-platform-M1.md#4-标准模板) 列出 Codex、Claude、OpenCode、Pi，原因为「{显示名}：暂时无法读取就绪状态，请重新加载部署选项。」（不可重试时「……请联系管理员。」），与部署状态说明给出同一个下一步，不按「部署没有标准模板」写「尚未登记」。「标准模板」与模型选择器禁用，已有模型选项的端点、默认模型与已选档位按最近一次读到的显示名显示（见[组件与调用方](#组件与调用方)，#3418 N14-06）；已选的模板（含修改申请的模板）按显示名显示，读不到部署登记时按 PRD 模板名，再查不到时为「标准模板」，不显示模板 ID（N9-2-01）。下拉展开时重读失败、随之禁用，弹层一起收起（公共 `Select`，同表单的「模型端点」等下拉一致），焦点交给页面标题（不可聚焦时为 `#main-content`），不落到 body、不滚动页面；重读挂起时保持原样。部署选项不可用（与部署状态说明同一条件：部署配置或模型目录的 `status` 不是 `populated`，含过期与 `empty`；`populated` 而没有模板时按「部署没有标准模板」与「修改申请的模板不可用」的已移除处理）时创建与修改标准模板申请都被拦下、不发请求：创建申请「标准模板」下为字段错误「部署选项暂不可用，请重新加载；标准模板申请暂不能提交。」（不可重试时「部署选项暂不可用，请联系管理员。」）；修改申请不能更换模板，由部署状态说明接手，不另写字段错误，先前的模板拦截提示随之收起；不对禁用的模型选择器列「请选择…」「至少…」。没有可操作的出错字段时焦点交给「重新加载部署选项」（经 `aria-describedby` 带上部署状态说明；不可重试时交给说明本身，`tabIndex=-1`），从页底提交时它滚入视口、停在吸顶顶栏之下，再次提交焦点回到它；顶部有提交失败提示时仍到顶部提示。重新加载进行中按钮保持可聚焦，读到后部署状态说明收起，焦点按[组件与调用方](#组件与调用方)的恢复按钮规则交出、不落到 body，字段错误按当前状态改写；修改申请打开时就读取失败、还没读到模板验证 revision 的，以重新加载后第一次读到的为准，可以直接提交，之后 revision 再变化仍按「修改申请的模板不可用」。自定义 Agent 与多服务 Agent 不受部署选项影响，照常提交；提交受理后的结果页不再显示部署状态说明与「重新加载部署选项」（N13-08、N13-09、N13-10） |
| 没有可申请的标准模板 | 创建申请、来源为标准模板，部署给出模板就绪状态但没有一项「可申请」（例如未接入验证时全部「尚未完成真实运行与模型验证。」，或分别未登记、验证失败、已停用、验证过期） | 同「部署没有标准模板」不能选择：未选模板时「标准模板」下拉为可聚焦的禁用（`aria-disabled`，不能展开，外观同禁用的 .5 不透明度与 `not-allowed`，占位「选择标准模板」），就绪列表照常列出每项原因（[PRD §4](../prd/PRD-agent-platform-M1.md#4-标准模板)）；提交被拦下、不发请求，「标准模板」下为字段错误「当前没有可申请的标准模板，请等待模板完成验证或联系平台管理员。」，其中有暂时读不到验证结果的模板时为「当前没有可申请的标准模板，请刷新后重试。」（与它的就绪原因给出同一个下一步），不提示「请选择标准模板。」；焦点到「标准模板」下拉，字段错误在它下方、视口内，经 `aria-describedby` 说明。之后部署选项重读到有模板可申请时下拉恢复可用，字段错误改为「请选择标准模板。」（N12-02） |
| 所选模板不可申请 | 来源为标准模板且部署给出模板就绪状态；所选模板的就绪状态不是「可申请」，或会话内重读部署选项后其验证 revision 变化 | 「标准模板」下为 polite 提示（14px），文案同就绪列表的原因（revision 变化时为「模板已更新，请刷新后确认。」）；就绪列表照常列出每项原因（[PRD §4](../prd/PRD-agent-platform-M1.md#4-标准模板)）。就绪原因只说明原因：验证过期（与当前登记不符或超出有效期，刷新后仍是过期）为「模板验证已过期，需等待平台重新验证。」，与验证失败、停用、未验证、未登记一样不引导刷新；只有暂时读不到验证结果时为「暂时无法读取验证结果，请刷新后重试。」（N11-01）。提交被拦下时字段错误沿用同一原因，提示随之收起，不并列同义说明，也不写笼统的「部署选项暂不可用。」；部署选项整体过期、不可用或没有标准模板时字段错误仍说明部署（未选模板时也是如此，同「部署没有标准模板」），部署正常、有可申请的模板而未选模板时为「请选择标准模板。」（一项都不可申请时见「没有可申请的标准模板」）。创建申请焦点到「标准模板」下拉。提交被拦下后部署选项重读（回到标签页、窗口重新聚焦）使就绪状态再变化时，字段错误按当前原因改写（例如验证过期变为可申请但 revision 变化时为「模板已更新，请刷新后确认。」，重读失败时改为说明部署），与就绪列表一致，不留着上一次提交时的原因；模板恢复且验证 revision 与所选时一致时清除，再次提交才重新拦下；「标准模板」下拉握着焦点时随重读禁用（部署选项暂不可用、没有登记模板），焦点交给页面标题（不可聚焦时为 `#main-content`），不落到 body（N12-01；展开的弹层一起收起，见「部署选项读取失败」，N13-08） |
| 修改申请的模板不可用 | 修改标准模板申请（已有申请不能更换模板，下拉只读）：申请的模板已从部署移除，或其就绪状态不是「可申请」、验证 revision 已变化 | 不引导改选或重新加载，提交被拦下、不发请求：顶部提交失败提示的同一位置显示 danger 提示（`role="alert"`，`tabIndex=-1`，页面只有这一条，先前服务端错误的说明让位），焦点移到它（只读的「标准模板」不作为焦点目标），再次提交焦点回到它；表单里还有可编辑字段出错时焦点先到第一个出错字段，顶部提示照常显示（同修改申请入口身份不可用）。已移除：下拉占位「已移除模板」，顶部「当前部署已移除此申请的模板，请新建申请。」，字段错误「该模板已从当前部署移除。已有申请不能更换模板，请新建申请。」；验证失败、已停用、验证过期（与当前登记不符或超出有效期，须等平台重新验证）、未验证或未登记：顶部「此申请的模板暂不可申请，请等待模板恢复后再提交，或新建申请。」，字段错误为就绪原因加「已有申请不能更换模板，请等待模板恢复后再提交，或新建申请。」（就绪原因不引导刷新，前后两句给出同一个下一步，例如「模板验证已过期，需等待平台重新验证。已有申请不能更换模板，请等待模板恢复后再提交，或新建申请。」，N11-01）；revision 变化或暂时读不到验证结果（刷新页面即可确认）：顶部「此申请的模板需要重新确认，请刷新页面后再提交。」，字段错误为就绪原因。提交被拦下后部署选项重读使就绪状态再变化时，顶部提示与字段错误按当前状态同源改写，与就绪列表一致：例如验证失败变为可申请但 revision 变化，顶部「此申请的模板需要重新确认，请刷新页面后再提交。」、字段错误「模板已更新，请刷新后确认。」；变为已移除，二者都改为新建申请。顶部提示仍是同一条，焦点留在它上面（改写由 `role="alert"` 播报）；模板恢复且验证 revision 与页面读到的一致时二者一起清除，焦点交给页面标题（不可聚焦时为 `#main-content`），不落到 body、不滚动页面，再次提交才重新拦下；重读失败时由部署状态说明接手，二者同样收起，再次提交仍被拦下、焦点到「重新加载部署选项」（见「部署选项读取失败」，N12-01、N13-09） |
| 多服务 YAML 未填写或语法错误 | 来源为多服务 Agent 时提交 | 「多服务资源 YAML 内容」下显示字段错误，焦点移到该文本框 |
| 默认 Key 没有可用模型 | 修改申请勾选「修改模型配置」，「检查可用模型」成功但没有候选 | warn 提示（`role="status"`）「该 Key 没有此模板可用的模型」与「请换一个 Key 后重新检查；当前模型配置保持不变。」，与 Owner 配置、替换 Key 弹窗同一种提示；提交时 Key 字段错误按情况为「请先点击「检查可用模型」并选好模型…」（未检查）、「该 Key 没有此模板可用的模型，请换一个 Key 后重新检查。」或「请在下方选好模型…」（已检查未选好） |
| 默认 Key 管理模型的选择 | 修改申请检查成功且有候选 | 与 Owner 配置同一个选择器（H4-17）：说明 13px、模型复选列表与单个「默认模型选项」，选择问题为 polite 字段错误（与 Key 字段拦截错误同一播报方式，#3291）；改选会移除当前模型时 warn 标题为「提交后会移除这些模型」 |
| 镜像升级进行中 | 自定义 Agent「镜像升级」已提交、尚未受理 | 只有本分区禁用，「升级中…」保持可聚焦；页脚仍是「保存配置」（暂停保存，不显示「保存中…」），整页字段不禁用；页脚「重启 Agent」、危险区「停止 Agent」与管理员区「停用 Agent」不受影响、保持可用，同一 Agent 的管理变更由服务端串行处理（[工程 Spec §10.3](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#103-并发与-leader)，#3291）。「当前来源：…」为分区说明（13px） |
| 镜像升级失败 | 升级请求失败 | 本分区内 danger 提示（`role="alert"`）「镜像升级未能提交，请重试。」（不可重试时「权限或 Agent 状态已变化，请刷新页面。」），焦点留在「升级镜像」；页脚不显示保存失败 |
| 保存时验证冲突 | 已保存 Key 模式保存返回 409 | 页脚 danger 提示「默认 Key 或配置已更新，请重新读取可用模型后再保存。」与「重新读取可用模型」；读取中为「正在重新读取…」（可聚焦）；默认 Key 状态与候选都读到后收起提示，改为 info 提示（`role="status"`）「可用模型已更新，请确认后保存。」，再次保存时收起；读取失败时提示保留 |
| 创建失败 · 配置与当前部署不兼容 | 失败类别 `configuration_rejected` | 与其他类别一样保留「重试创建」（[PRD §6.3](../prd/PRD-agent-platform-M1.md#63-管理状态)）；说明为「……调整配置或部署之前重试创建不会成功。请按部署支持的配置重新申请，或联系系统管理员调整部署后再重试创建。」（[工程 Spec §10.5](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#105-自定义-agent-runtime-manifest)） |
| 不是 Owner | 在使用范围内的员工打开 Owner 配置；非 Owner（含纯管理员）打开 Agent 的 Skill 页 | 公共「无法访问」卡（P-01），只提供「返回 Agent 详情」：Owner 配置页头为「Owner 配置」，说明「只有当前 Owner 可以修改这个 Agent 的配置。」；Skill 页说明「只有当前 Owner 可以管理这个 Agent 的 Skill 绑定。」，不显示「返回 Owner 配置」与「浏览 Skill Hub」 |
| 名称下拉未选 | 标准模板限定的「添加 Secret」名称与环境变量名 | 「请选择 Secret 名称。」「请选择环境变量名。」；名称自由输入时为「请输入…」 |
| 移除可重复的行 | Owner 配置的环境变量；申请表单的模型选项、环境变量与 Secret | 焦点规则见 D2-59 |

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

### 对话 Skill 控制文件

[#2891](https://github.com/AgoraIO-Extensions/agent-infra/issues/2891) 为已选 Skill 增加控制文件入口（Invocation V2，
上传沿会话文件授权，[PRD §11.3](../prd/PRD-agent-platform-M1.md#113-原生命令与已安装-skill)、[§12.1](../prd/PRD-agent-platform-M1.md#121-附件和结果文件)），
[#3259](https://github.com/AgoraIO-Extensions/agent-infra/issues/3259) 收敛了它的排版与状态，
[#3270](https://github.com/AgoraIO-Extensions/agent-infra/issues/3270) 已按本节回写导出稿（演示入口在「原型状态」页「命令与 Skill 交互场景」；`conversation-skill-control-files.tsx`、`index.css` `.skill-control-files`）。
[#3267](https://github.com/AgoraIO-Extensions/agent-infra/issues/3267) 起，文件行、失败分类、「重试」是否出现、播报与动作后焦点
与[对话会话文件附件](#对话会话文件附件)共用 `conversation-upload-rows.tsx`，两处只在排版上不同。

- 位置与内缩：输入框内、已选 Skill 卡与错误行之后，只在选中 Skill 时出现（命令没有）。与已选 Skill 卡、错误行同一套内缩：
  桌面 `margin: 8px 12px 0`，≤767px `8px 8px 0`；≤767px 的错误行同样收为 8px，三者左右边缘对齐。
- 字号：标题「Skill 控制文件」12px / 600，限制说明 11px `--muted-ink`，单行说明 12px `--muted-ink`；文件名 12px，
  行内状态 11px（上传中、已上传为 `--muted-ink`，失败与过期为 `--danger-ink`）。
- 排列：标题与限制说明在左，44px outline「添加文本文件」（`aria-describedby` 指向限制说明）在右，同一行；
  文件逐行为图标、名称与状态两行，失败或过期时有「重试：{文件名}」，行尾为 44px 图标按钮「移除控制文件 {文件名}」。
  同名文件按出现顺序加「（第 N 次）」（`distinctObjectNames`）。

| 状态 | 条件 | 呈现 |
| --- | --- | --- |
| 不支持上传 | Agent 未开启附件能力 | 只有一行「当前 Agent 不支持上传控制文件，只能提交任务说明。」，没有入口与限制说明 |
| 限制读取中 | 会话文件限制尚未返回 | 只有一行「正在读取文件限制…」 |
| 限制不可用 | 限制读取失败或响应无效 | 只有一行「文件限制暂不可用，上传入口已关闭。」 |
| 不接受 text/plain | 会话文件限制不含 `text/plain` | 只有一行「当前会话不接受 text/plain 文件，只能提交任务说明。」（#3267） |
| 可上传 | 已读到限制 | 标题、「添加文本文件」与「仅支持 text/plain 文本文件，最多 4 个，单个文件不超过 4096 字节。」；选择不合规时说明下方出现 12px `--danger-ink` 错误行 |
| 上传中、已上传 | 文件行 | 状态为「上传中…」「已上传」 |
| 失败、过期 | 文件行 | 「上传失败，请重试。」「上传授权已过期，请重试。」与「重试：{文件名}」 |
| 内容不是 UTF-8 文本 | 文件行，内容不是有效的 UTF-8 文本 | 「文件内容不是有效的 UTF-8 文本，与文件类型不符。」，与会话附件同一文案；确定性失败，没有「重试」，只能移除（#3267） |

播报与焦点：静态说明不设 role；区块内一个常驻 `role="status"` 只在状态变化时播报「{文件名} 上传中… / 已上传」与「已移除 {文件名}」，
上传失败与选择错误用 `role="alert"`。添加后焦点留在「添加文本文件」，重试后到同一行的移除按钮，
移除后到「添加文本文件」，入口不可用时到输入框。

### 对话结果文件与产物预览

[#3133](https://github.com/AgoraIO-Extensions/agent-infra/issues/3133) 与 [#3248](https://github.com/AgoraIO-Extensions/agent-infra/issues/3248)
在回复卡与回答正文中展示结果文件（见[OpenDesign 视觉版本](#opendesign-视觉版本)的预览说明）。#3270 已按 main 回写导出稿
（`sandbox-reference-views.tsx`、`conversation-screen-messages.tsx` `ResultFileList`、`conversation-artifact-preview.tsx`、`index.css` `.sandbox-*`、`.artifact-*`）。

- 回答内图片：`sandbox:` 图片命中可预览的结果文件时为按钮「预览图片：{说明}」（最大 480×320，1px 边框、8px 圆角、muted 底）；
  读取中为「正在加载图片：{说明}」，读不到为「图片未发送：{说明}」，执行未结束时为「图片待发送」「文件待发送」；
  同一文件的再次引用与远程图片只写「[图片：{说明}]」，不加载地址。
- 回答内文件卡：`sandbox:` 链接命中结果文件时为 group「结果文件：{文件名}」：20px 文件图标、可选 12px muted 说明、
  600 字重文件名与「{类型} · {大小}」，右侧 ghost「预览」（仅可预览的类型）与 outline「下载」；1px 边框、8px 圆角、
  内边距 8px 12px，窄屏换行，不超出正文；未命中的链接写「{文字}（文件未发送）」。
- 「结果文件」列表：回复卡状态行之后，14px / 500「结果文件」，逐行「{文件名} ({大小})」；已在回答中显示的行（含读取中的内联图片，#3294 O9-07）只写
  12px muted「已在回答中显示」，其余为「预览」「下载」，准备中为「准备预览…」「准备下载…」（`aria-disabled`，焦点留在按钮上）。
- 产物预览弹窗：标题为文件图标与文件名，最宽 900px；图片、PDF 与静态 HTML（隔离 iframe，高 60dvh）原样显示，
  文本与 diff 为等宽 12px / 1.6、muted 底、在 min(60dvh, 560px) 内滚动，diff 先列「+N 新增」「-N 删除」，增删行为 14% 混色底。
  读取态见[对话结果文件预览](#对话结果文件预览)；页脚 outline「下载」与主按钮「关闭」，关闭（Esc、「关闭」或「关闭弹窗」）后焦点回到触发按钮。

### 命令与 Skill 调用回执

[#2891](https://github.com/AgoraIO-Extensions/agent-infra/issues/2891) 的调用不写会话消息
（[工程 Spec §11.4](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#114-原生命令与已安装-skill-边界)），
本节对应的导出稿已在 #3270 按 main 回写（`conversation-capability-receipt.tsx`、`active-conversation.tsx`、`index.css` `.capability-receipt`）。

- 确认发送后不追加用户消息与回复卡；回执是时间线末尾的独立块，与头像列左缘对齐，最宽 760px，1px 上边线、
  上内边距 10px，12px：「Skill · {名称} · v{版本}」或「原生命令 · {名称} · {版本}」（550 字重），阶段
  「已受理，尚未开始」「正在执行」「已完成」「调用失败」「结果待核实」「已停止」（`role="status"`），附带控制文件时另起一行
  「控制文件：{文件名}、…」；失败时为 `--danger-ink`「所选版本加载失败。内容没有降级为普通消息。」，待核实时为
  「沿原操作核实结果；核实前不会再次执行。」。操作为 ghost「调用详情」，待核实时另有 outline「核实原操作」。
  执行中与结果待核实时（执行尚未终止），回执之后是 outline「停止回复」；已完成、调用失败与已停止时没有（#3294 O9-05）。
- 确认发送后焦点回到输入框。服务端拒绝时保留所选项，原因写在已选卡下的错误行（12px `--danger-ink`，O8-01）。

### 管理与设置页的缺失状态

[#3269](https://github.com/AgoraIO-Extensions/agent-infra/issues/3269)（#2830 终验第八轮）与
[#3292](https://github.com/AgoraIO-Extensions/agent-infra/issues/3292)（第九轮，标 N9-3-xx 的行）补齐了导出稿没有画出的以下状态，
[#3351](https://github.com/AgoraIO-Extensions/agent-infra/issues/3351)（第十一轮，标 N11-03 的行）补充了项目内容保存冲突后重新读取的焦点；
这些状态只用公共组件或已画结构的变体呈现，按[回写边界](#opendesign-视觉版本)导出稿不逐一画出（#3270）；「停用应用」确认属于 API 凭证与应用管理的
明确豁免（#3294 N9-3-10）。以本节为准，焦点去处同时登记在 D2-59。

| 位置 | 状态 | 结构与规则 |
| --- | --- | --- |
| `/admin/approvals` 审阅弹窗 | 批准或驳回失败 | 失败提示（`role="alert"`）在正文区末尾、操作区之前（批准与驳回两个视图，同 Skill 审阅弹窗），与上一条提示相距 12px；出现时把操作区与提示滚入弹窗可视区，焦点留在触发的按钮上（N8-3-01） |
| `/audit`、`/admin/audit` 分页 | 读取中、查询条件出错 | 页码不显示时「上一页 / 下一页」仍靠右（`.audit-pagination > .tag-row:only-child`），位置不随读取横跳；空闲时页码在左、按钮在右（N8-3-03） |
| `/skills/manage/new` 配套文件 | 文件数量与合计大小校验 | 「最多 100 个文件（含 SKILL.md）。」「所有文件合计不能超过 512 KB。」在限额行下方；文件增删或内容变化后按当前草稿重算，不再满足时清除，不与限额行矛盾（N8-3-07）。「文件内容」与导出稿相同固定 180px、可纵向拉伸，长内容框内滚动（N8-3-05） |
| `/skills/manage/new` 项目内容 | 保存冲突（409）后「重新读取内容」 | 右栏 danger 提示「内容已在其他地方修改。请重新读取后再编辑，未保存的修改会丢失。」下为 outline「重新读取内容」（公共 `RecoveryButton`）。重读进行中按钮不收起，为可聚焦的禁用「正在重新读取…」（`aria-disabled`）并留住焦点，提示保留；读到内容后提示与按钮收起，草稿按服务端内容重新初始化，焦点到 SKILL.md 文本框；仍读取失败时内容区换成读取失败空态（「暂时无法读取 Skill 内容 / 已发布的版本不受影响。」与「重新读取」），焦点到其中的「重新读取」（同一恢复操作），读取 401 换成「重新登录」时到页面 h1；动作进行中与完成后焦点都不落到 body（N11-03）。重读进行中离开页面（浏览器后退）时不把焦点交给上一页的标题（N12-03） |
| `/my-settings/relay-key` | 状态未知：读取中、读取失败、写入被拒（401 / 403）后清空投影 | 页头不显示状态 chip；分区标题为「个人 Key」，说明为「读取当前状态后才能设置、替换或撤销。」，不按未设置写「接入个人 Key」；主按钮为禁用的「保存 Key」，没有「撤销 Key」（N8-3-08） |
| `/my-settings/api-credentials` | 签发个人凭证的一次性凭证、幂等重放与签发失败；应用管理签发应用凭证失败 | 提示仍在页顶（应用管理在分区顶部），出现后滚入视口（让出吸顶顶栏，见[组件与调用方](#组件与调用方)）并接过焦点：一次性凭证到提示标题「已签发个人 API 凭证」，幂等重放与失败到提示本身（N8-3-09） |
| `/my-settings/api-credentials` 行内收窄表单 | 「保留的权限」选项 | 与同页「签发个人凭证」的权限选项相同：10px 圆角、14px、悬停 muted 底色，右侧为 11px 权限码；复选框名称仍为「{权限}：{凭证标识}」（C2-19，N8-3-10） |
| `/admin/approvals`、`/admin/agents`、`/admin/skill-reviews`、`/admin/audit` | 员工打开（无权限），以及 Agent 管理列表读取 403 | 四页相同：页头保留 eyebrow、h1 与说明，不显示页头工具；其下只有公共 `PageStateCard`（`unauthorized`）「未授权 / 当前无权访问{创建审批 / Agent 管理 / Skill 审核 / 平台审计}。」与 outline「返回工作台」，不设 role，不发出系统管理读取（N9-3-01） |
| `/admin/skill-reviews` | 目录名称读取失败 | `DirectoryReadAlert` 与下方审核列表相距 16px，与其余调用方相同（N9-3-03） |
| Skill Hub（目录、版本详情、我的 Skill 两个分区、Skill 审核队列、项目内容）、`/my-settings/relay-key`、`/my-settings/api-credentials`（个人凭证列表与应用管理）、`/admin/agents` | 读取 401 | 不写「暂时无法访问…请联系管理员」：Skill Hub 为读取失败空态「登录已过期 / 登录状态已失效，请重新登录后再试。」与 outline「重新登录」（16px `LogIn`），设置页为分区内 danger 提示同一句与 outline「重新登录」，Agent 管理同 Agent 目录为「登录已过期」状态卡（主按钮「重新登录」与 #states 代表卡、工作台相同，带 16px `LogIn`，N10-1-04）。「重新登录」经壳层确认会话（`useSessionRecheck`）：仍有效时解除不可重试读取的锁定、重读一次，已失效时整页换成登录页，焦点同主动退出交给登录页（D2-59，N10-1-01）（W-03，N9-3-04） |
| `/skills/manage`「已安装」与「我创建的」；API 凭证页个人凭证列表与应用管理 | 两处同时读取失败 | 恢复按钮的可见文字不变，名称与恢复 key 带分区名：「重新读取：已安装」「重新读取：我创建的」「重新登录：已安装」「重新登录：我创建的」，应用管理为「重新加载：应用管理」「重新登录：应用管理」；同页不出现同名控件，仍失败时焦点回到同一分区的按钮（D2-58，N9-3-05；503 的「重新加载：应用管理」为 #3329 N10-3-01） |
| `/my-settings/api-credentials?applicationId=…`「停用应用」 | 确认弹窗取消、Escape 与停用中 | 取消或 Escape 回到「停用应用：{应用名}」；确认后焦点仍在它上面，停用中为可聚焦的禁用「正在停用…」（`aria-disabled`），停用成功、详情按新状态回读后到应用名标题（N9-3-06） |

### 对话会话文件附件

「会话文件」折叠条（CH-03）内的附件区，上传沿会话文件授权（[PRD §12.1](../prd/PRD-agent-platform-M1.md#121-附件和结果文件)）。
[#3270](https://github.com/AgoraIO-Extensions/agent-infra/issues/3270) 已按本节回写导出稿（演示入口在「原型状态」页「会话文件」），以本节为准（`conversation-files.tsx`、`index.css` `.conversation-files`，[#3267](https://github.com/AgoraIO-Extensions/agent-infra/issues/3267)）。

- 入口：可上传时为 44px outline「添加附件」（`aria-describedby` 指向限制说明）与其后一行限制说明「支持 {类型}，单文件最大 {大小}」
  （11px `--muted-ink`）；隐藏文件输入名为「选择附件文件」，与按钮不同名。入口在文件列表上方。
- 文件行：按导出稿 `.chat-file-row` 为行卡（1px 边框、9px 圆角、8px 内边距、`--surface-raised` 底，行间 8px），≤767px 顶对齐；
  依次为 16px 文件图标（图片为 40px 本地缩略图）、名称与状态两行、可重试时的 outline「重试：{文件名}」与行尾 44px 图标按钮
  「移除附件 {文件名}」。名称 12px / 700，占满操作之外的宽度，按字符折行，整名可见；下方状态 11px，上传中、已上传为 `--muted-ink`，
  失败与过期为 `--danger-ink`，不用带边框的提示框。按钮保持 44px 触达下限。同名文件按出现顺序加「（第 N 次）」。
- 摘要：「{N} 个文件 · {M} 个待重试」，M 只计可重试的失败；有不可重试的失败时追加「 · {K} 个无法上传」；限制不可用时为
  「{N} 个文件 · 上传暂不可用」。折叠条的标题「会话文件」、「按需查看」与展开 / 收起提示不收缩、保持单行，窄屏只有摘要文字换行（#3294 O9-06）。

| 状态 | 条件 | 呈现 |
| --- | --- | --- |
| 不支持上传 | Agent 未开启附件能力 | 不显示「会话文件」折叠条 |
| 限制读取中 | 会话文件限制尚未返回 | 只有一行「正在读取文件限制…」（12px `--muted-ink`），没有入口与限制说明 |
| 限制不可用 | 限制读取失败或响应无效 | 只有一行「文件限制暂不可用，上传入口已关闭。」 |
| 可上传 | 已读到限制 | 「添加附件」与限制说明 |
| 上传中、已上传 | 文件行 | 状态为「上传中…」「已上传」 |
| 失败、过期 | 文件行 | 「上传失败，请重试。」「上传授权已过期，请重试。」与「重试：{文件名}」；授权过期时重试前先重读限制，文件已不符合时按上传前拒绝显示 |
| 上传前拒绝 | 类型或大小不符合当前限制 | 「当前 Agent 不支持此文件类型。」「文件超过 {大小} 限制。」，不创建上传；确定性失败，没有「重试」，只能移除 |
| 内容不是 UTF-8 文本 | 声明为文本类型，内容不是有效的 UTF-8 文本 | 「文件内容不是有效的 UTF-8 文本，与文件类型不符。」，不创建上传，没有「重试」 |

播报与焦点：同[对话 Skill 控制文件](#对话-skill-控制文件)。静态说明不设 role；区块内一个常驻 `role="status"` 只在状态变化时播报
「{文件名} 上传中… / 已上传」与「已移除 {文件名}」，失败原因为行内 `role="alert"`。重试后焦点到同一行的移除按钮，
移除后到「添加附件」，入口不可用时到输入框。

### 对话结果文件预览

结果文件的预览弹窗（见[OpenDesign 视觉版本](#opendesign-视觉版本)）已在 #3270 回写导出稿；读取态以本节为准
（`conversation-artifact-preview.tsx`）。标题为文件名，页眉图标钮为「关闭弹窗」，页脚为「下载」与「关闭」（X-04）。
读取中为公共 `LoadingLine`「正在准备预览…」；读取失败为 danger `Alert`（`role="alert"`）「文件读取失败，请重试。」与 outline
「重新读取」，文本内容无法解码时为「文件内容无法读取。」（`role="alert"`）；不支持的类型为「该文件类型暂不支持在线预览，请下载后查看。」。
打开后与读取中焦点在弹窗容器上；「重新读取」后先到弹窗容器，仍失败时回到新的「重新读取」，成功后留在弹窗容器；关闭后回到触发的「预览」。

### 对话访问失效

页面使用中失去访问（会话或命令被拒且复核后确实失去权限，例如发送后 404 而 Agent 仍可用，#2570）时，页头只留 h1「对话」，
其下为 danger `Alert`（`role="alert"`）「当前登录或访问权限已失效，请重新登录或返回 Agent 目录。」与「返回 Agent 目录」。
这个状态只用公共组件呈现，按[回写边界](#opendesign-视觉版本)导出稿不画（#3270）。原来的焦点（发送按钮、输入框）随整块替换卸载，焦点已落到 body 时交给 h1（#3267 N8-1-10）。

### 对话页状态说明行

[#3293](https://github.com/AgoraIO-Extensions/agent-infra/issues/3293)（#2830 终验第九轮 N9-1-01）统一了对话页状态说明行的字号。
导出稿只画代表态：「准备重新发送」后的「请确认草稿后手动发送；不会自动提交。」（`.chat-draft-notice`，演示入口在「原型状态」页「发送失败」），已按本节回写为 14px / 20px、与输入框相距 10px（短视口 6px，#3294）；其余说明行只换文案，按[回写边界](#opendesign-视觉版本)不逐一画出，以本节为准（`active-conversation.tsx`）。

- 字号：说明行为 14px / 20px（`text-sm`）、400、正文前景色，左缘与输入框对齐；字号同导出稿 `.chat-draft-notice`，不继承正文 15px。
- 时间线之上：自动重连期间为「会话连接中断，正在自动重新连接，草稿会保留。」；重连用尽或读取暂不可用后换成公共 warn `Alert` 与「重新连接」。
- 输入框上方，依次为「原执行结果待核实，同会话暂不能发送下一条消息。」与行内 ghost「核实原执行状态」（重读会话并打开执行详情）、
  「会话准备中 / 会话更新中，完成后即可发送。草稿会保留。」（新会话首条消息等待自动发送时为「……完成后自动发送这条消息。」）、
  处理中且 Runtime 不支持补充指令时的「当前回复仍在处理，这条消息发送后进入排队，按顺序处理。」，
  会话已有排队消息时的「会话中已有排队消息，这条消息发送后排在它们之后。」（#3376），
  会话所选（或 Agent 默认）模型选项已不在模型清单时的「原模型选项已移除；提交消息时，标准模板将使用 Owner 的默认选项。你也可以刷新并重新选择。」（#3327 N10-1-03），
  以及页内提示（如「请确认草稿后手动发送；不会自动提交。」）。
- 播报：上面两条排队说明是静态说明，不设 role，由发送按钮 `aria-describedby` 引用；「原模型选项已移除」同为静态说明，不设 role；
  上面其余说明行在状态变化时出现，自身为 `role="status"`。

### 侧栏退出登录

生产构建配置了同源退出入口（`VITE_PLATFORM_LOGOUT_URL`）时，侧栏底部身份行之下有「退出登录」；#3270 已回写导出稿（失败演示在「原型状态」页）。
入口与相邻未选中导航项相同：44px、内边距 8px 11px、13px / 400 / muted，悬停为 `--fg`，不使用公共按钮的 650 字重与字距。
退出中为可聚焦的禁用「正在退出…」；失败时下方为 12px `--danger-ink` 的 `role="alert"`「退出登录失败，请重试。」，左缘与入口文字对齐，
焦点留在入口上；退出后整页换成登录页，焦点到「公司账号」（K7-02）。窄屏导航 Sheet 内相同（#3267 N8-1-01）：进行中与失败时 Sheet 保持打开，焦点与失败提示都在 Sheet 内（#3294 O9-01），重绘时 Sheet 不收起、不重放滑入动画（#3330 O10-01）。

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
| `Field` / `FieldError` | 字段标签与控件的容器；`FieldError` 为字段下方的校验错误（默认 `role="alert"`），如审批驳回原因。字段级错误的样式只由它维护（12px / 1.5、`--danger-ink`、上距 6px），调用方用 `announce` 选择 alert、polite、assertive 或不另行播报（#3268） |
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

后台重读（[#3387](https://github.com/AgoraIO-Extensions/agent-infra/issues/3387)）：回到标签页、窗口重新聚焦
（TanStack Query 的 `refetchOnWindowFocus`）、轮询与写入后的失效重取都是后台重读。页面已显示过一次读取结果时，
后台重读进行中或遇到可重试的失败（503、网络中断）都不替换已显示的内容：不换成读取中或读取失败卡，不收起列表、
表单、筛选与提示，未保存的输入、焦点与滚动位置保留，也不另加提示（同目录名称批量读取）；下一次读到时按新结果更新。
没有结果、失败不可重试（登录失效、无权、不存在、响应无效），或用户发起的读取（页头刷新、「查询」「重置」、翻页、
恢复按钮、「重新登录」与「重新检查」确认会话）仍按 D2-59 显示读取中与读取失败，失败一直显示到下一次读到结果（对话页「刷新 Agent 状态」见 D2-59，#3419 N14-12）。
已显示内容之后的不可重试失败与首次读取失败一致（#3433）：对话页的 Agent 读取（轮询或回到标签页）读到不存在或响应无效时
换成与 `/agents/:id` 同一套读取失败卡，工作区与「发送」收起（N15-04）；Agent 的 Skill 页的当前 Agent 版本显示
「暂时无法读取当前 Agent 版本」，不再用旧版本读写绑定；自定义 Agent 对话页的 Runtime 模型目录收起模型入口、阻止发送，
草稿与焦点保留，下一次读到时恢复。
审计列表后台重读期间只有页头「刷新审计记录」显示读取中（`aria-disabled`），表格不换成读取行。共用判断在
`features/background-read.ts`。申请表单的部署选项读取不在此列：重读失败由表单内的部署状态说明接手（N12-01），页面与其余字段不被替换。
这些状态只用已有结构呈现，按[回写边界](#opendesign-视觉版本)不逐一画出，导出稿不画后台重读。

轮询与派生读取同样按上面的规则（[#3418](https://github.com/AgoraIO-Extensions/agent-infra/issues/3418)）：
轮询（Agent 创建、启动或更新期间每 2 秒重读，详情、Owner 配置、Agent 的 Skill、管理员单项读取与对话页共用）以最近一次读到的结果
判断是否继续（`pollWhileShown`），可重试的失败之后按原节奏继续，读到新结果就更新，没有结果或失败不可重试时停止。
不经 TanStack Query 的手写轮询用同一规则（`retryablePollFailure`：没有响应、408、429 与 5xx 可重试，`retryable: false`、
其余 HTTP 失败与 2xx 响应无效不可重试）。轮询调用方（[#3433](https://github.com/AgoraIO-Extensions/agent-infra/issues/3433) 全量排查）：

- Agent 生命周期：Agent 详情、Owner 配置、Agent 的 Skill、管理员单项读取（`use-agent-detail.ts`、`use-admin-agent.ts`）
  与对话页（`conversation-screen.tsx`，不可重试失败换成读取失败卡，N15-04）。
- Skill 绑定同步（`agent-skill-binding-screen.tsx`）：存在等待同步或已同步未装配的绑定时每 2 秒重读绑定并一并重读 Agent；
  不可重试失败显示「无法读取 Skill 绑定」，两者一起停止（N15-01）。
- 企微机器人、企微应用手动验证后的配置会话（`wecom-bot-setup.tsx`、`wecom-app-setup.tsx`）：可重试失败保留
  「配置结果暂未确认，正在重新查询」并继续；不可重试失败结束验证，卡内为「配置会话已失效，请重新配置。」，焦点在
  「验证并绑定」上时到卡片标题（N15-02）。
- 企微连接状态（已断开、验证中每 2 秒）：可重试失败保留上一次状态继续，不可重试失败停止并显示「连接状态暂不可用」（N15-03）。
- 执行详情的 Connection 安装状态（`connection-installation-panel.tsx`，每 2 秒、最多 30 次）：可重试失败保留
  「等待 Connection 确认」、不另加提示，用满 30 次为「轮询已暂停，请稍后重新读取状态。」；不可重试失败停止并显示
  「Connection 安装暂不可用。」，同一个步骤按钮换成「开始安装」，焦点不动；用户按「查询状态」的可重试失败提示
  「暂时无法读取安装状态。」，显示到下一次读到结果。
- 会话准备中与更新中的会话投影（`active-conversation.tsx`，每 500ms，上一次读完才排下一次）：可重试失败保留历史与草稿、
  沿用对话页的连接中断提示并继续，读到就绪停止；不可重试失败按对话页的读取失败与[对话访问失效](#对话访问失效)停止。
- 不属于轮询：事件流自动重连（`conversation-timeline.ts`，有限次数，见 D2-59 的「重新连接」）、扫码窗口关闭检测
  （`wecom-qr-authorization.ts`，不读服务端）、倒计时与提示定时器。

以上轮询状态只用已有结构呈现，按[回写边界](#opendesign-视觉版本)不逐一画出。
部署配置的派生读取（Owner 配置的模型目录与环境变量名、各页的模板显示名、申请表单「模型端点」「默认模型」的显示名）读到过之后，
后台重读的可重试失败继续用最近一次读到的结果（`useShownDeploymentConfiguration`）；申请表单的部署状态说明与提交拦截仍按当前读取结果。
Owner 配置已保存 Key 的可用模型即使已有候选，失败不可重试时也按 D2-59 显示「无法读取可用模型」并收起选择器，草稿里未保存的模型选择撤回、
不随保存提交，焦点在选择器里时交给「模型与凭证」标题；撤回的是唯一的未保存修改、「保存配置」随之禁用时，焦点在按钮上的交给紧挨按钮的
「没有需要保存的变更。」（同保存完成，#3433 N15-05）。申请表单部署选项读取失败时（N13-08）模型选择器禁用，「模型端点」「默认模型」
按最近一次读到的显示名，没有时端点写「暂时无法读取端点名称」、默认模型只写模型名，不显示原始端点 ID、不写「已移除模型」；
「允许的推理档位」保留已选档位（禁用）并写「部署选项读取后可调整。」，「添加模型选项」`aria-disabled`、不添加空行。
同样按回写边界导出稿不画。

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
恢复焦点只交接一次：交给恢复目标后，或用户按下指针、按键、点击、把焦点移到别处（含点主区空白处使焦点到 `#main-content`）之后不再代管，
之后的重读与重绘不再把焦点拉回标题，也不滚动页面（交接目标随重绘卸载、焦点丢到 body 时只就地补回）。同一个恢复操作只在本次恢复请求进行中重新出现（仍失败）时取回焦点；
请求有了结果（`onClick` 返回的 Promise 结束，页面与壳层会话的 QueryClient 也没有进行中的读取）之后，它因后台重读再次出现（成功或失败）都不取回焦点、不滚动，
不经 TanStack Query 的恢复请求由 `onClick` 返回请求的 Promise（#3388 N13-04）。
「离开该页面」只指 pathname 变化或恢复按钮随导航卸载：触发后离开（含重读进行中浏览器后退到上一页）不代管，新页面的焦点同普通导航（#3364 N12-03）；
同一页面只改查询串（筛选、分页、Tab、`?view=`、`?applicationId=` 后退等）而按钮仍在文档中，或壳层状态卡跨路由保留时，代管继续，结果按同页规则（成功到 h1 或指定目标，仍失败回到按钮）；
查询串代表另一个资源、页面随之重挂载时由调用方用 `RecoveryPageParams` 声明，这些参数变了即离开页面（Skill 编辑器的 `?project=`，#3388 N13-03）。
持有焦点的控件因非用户发起的重绘（后台重读、自动重连）卸载或变为原生禁用时，焦点交给同页的下一个合理目标，不落到 body、不滚动页面（#3388 N13-05、N13-06）：
未按下的恢复按钮（获得焦点后用户没有再按键、按下指针或点击）同按下后的规则，到页面 h1（或指定目标），同一个恢复操作在请求进行中重新出现时回到按钮；
页面级状态卡（读取失败、登录失效、无权、不存在）替换主内容、收起持有焦点的筛选控件时到页面 h1，不可聚焦时到 `#main-content`（`PageStateCard` 与 `RecoveryButton` 挂载时检查）；审计「上一页」「下一页」因不是本按钮触发的变化（回到标签页的后台重读读到末页等）变为禁用时交给另一个分页按钮，两个都不可用时到页面 h1。
焦点丢失兜底（[#3419](https://github.com/AgoraIO-Extensions/agent-infra/issues/3419) N14-07、N14-08、N14-09）：应用壳层（`useFocusLossFallback`）兜住以上规则没有覆盖的调用方：主内容区或公共 `Dialog` 弹窗里最近持有焦点的元素已从文档移除或变为原生禁用、焦点落在 body 时，把焦点交给仍打开的所在弹窗，否则页面 h1（不可聚焦时 `#main-content`），`preventScroll`。更精确的目标优先：页面自己的交接（同一次提交的 effect）、`PageStateCard` / `RecoveryButton` 挂载时的检查（`useRestoreLostFocus`）、恢复代管与指定的 `recoveryTarget` 先处理，兜底稍后（约 50ms）才接手仍落在 body 的焦点。不接手：用户按下指针（点击空白处）、换了路径（浏览器后退离开页面；`page.goto` 等直接打开没有焦点记录），以及紧接在用户激活操作（点击、Enter、Escape、非文本输入控件上的空格、浏览器前进后退）之后约 1 秒内的丢失，它是用户操作的结果，由页面在结果出来后交接（例如点击后随之禁用的发送按钮）；在文本框里输入文字不算激活。详情区域内未按下的「刷新审计详情」随后台重读卸载时交给详情区域（详情区域也已卸载时到 h1），不滚动（N14-10）。
审批队列不可重试的读取失败（「审批列表不可用，请联系管理员。」，没有恢复按钮）挂载时按 `PageStateCard` 的同一检查自己交接：
列表与搜索框随之卸载、焦点落到 body 的交给 h1「审批申请」，用户刚点进搜索框或按 Enter 后约 1 秒内的丢失同样如此（#3433 N15-07）。
以上状态按[回写边界](#opendesign-视觉版本)导出稿不逐一画出（`hooks/use-recovery-focus.ts`）。
按钮所在分区离页面标题很远或在弹窗内时传 `recoveryTarget`（「应用管理」的「重新加载」到分区标题，执行详情与产物预览的
重新读取到弹窗，模型设置「重试」到模型入口）；`DirectoryReadAlert` 的「重新读取目录」同样是 `RecoveryButton`。
其余点击后自身卸载的按钮按同一规则交出焦点：无匹配空态「清除筛选」回到搜索框，「关闭一次性凭证提示」回到「签发个人凭证」，
状态推进的步骤按钮复用同一个元素（Connection 安装「开始安装 / 查询状态 / 重新开始」，#3269 N8-3-02）。
用户触发后在读取或写入进行中不可用的触发按钮（提交、确认型写操作、加载更多、查询与翻页、预览与下载等）同样用
`focusableWhenDisabled` 或 `RecoveryButton` 保持可聚焦，不用原生 `disabled`，也不放在随之禁用的 `<fieldset>` 内；
其余字段仍可原生禁用，在字段里按 Enter 提交时焦点先交给提交按钮（`hooks/use-submit-focus.ts`），对话输入框提交中只读（`readOnly`、`aria-disabled`）而不是禁用。
完成后按 D2-59 交出焦点；「加载更多」读完随之卸载时焦点到新加载的第一项（`hooks/use-load-more-focus.ts`），
主动退出后整页换成登录页、焦点到「公司账号」（开发模式为「选择开发测试身份」），进行中与完成后都不落到 body（#3242 K7-02）；
已就绪的会话在同一文档内确认失效、整页换成登录页时相同（「重新登录」——状态卡、工作台、Agent 目录、Agent 管理、Skill Hub 与设置页——确认会话已失效即属此类），
未配置登录入口的构建没有登录控件，焦点到「登录工作区」标题；直接打开登录页时不抢焦点（`login-page.tsx` 的 `focusOnEntry`，#3327 N10-1-01）。
主按钮形态的「重新登录」（状态卡默认操作、工作台、Agent 目录、Agent 管理）共用 `page-state-card.tsx` 的 `ReloginButton`，
带 16px `LogIn`；Skill Hub 与设置页的 outline「重新登录」同样带 `LogIn`（#3327 N10-1-04）。
`Dialog` 关闭后焦点回到触发按钮；触发按钮当时被禁用、已卸载或随后随列表回读卸载时，焦点移到同一目标，不落到 body。调用方指定了 `finalFocus` 时，关闭（含随所在分区被后台重读卸载）时目标已不在文档、焦点落到 body 的，交给上述焦点丢失兜底的同一去处，不滚动（#3419 N14-09）。
吸顶顶栏让位（[#3329](https://github.com/AgoraIO-Extensions/agent-infra/issues/3329) N10-3-02；导出稿以 `--topbar-h`、`.topbar` 同步，#3330 O10-03）：顶栏 `position: sticky`、高 `--platform-topbar-height`（72px，1440 与 390 相同）。根滚动容器 `html` 的 `scroll-padding-top` 为
`calc(var(--platform-topbar-height) + 16px)`：程序聚焦、Tab、页内锚点（「跳至主要内容」）与 `scrollIntoView` 把可视区上缘算在顶栏下 16px，
目标滚入视口后不被顶栏遮挡（WCAG 2.2 SC 2.4.11）。顶部让位只由它承担：元素不再用 `scroll-margin-top` 让出顶栏（会与之叠加），`.action-reveal` 只保留下缘 16px，
需要按顶栏位置计算的脚本（Agent 管理翻页）读根的 `scrollPaddingTop`；顶栏内控件的滚动目标区下移同样距离（`scroll-margin` 上 -88px、下 +88px），
聚焦时不滚动页面。对话时间线等局部滚动容器沿用各自的 `scroll-padding`。
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
| 详情读取 403/404（P-01） | 共用「无法访问」卡，说明资源不存在或无权访问，只提供返回上级，不重试、不区分对象是否存在。Owner 配置与 Agent 的 Skill 页读到 Agent、但当前用户不是 Owner 时同用这张卡（#3268）。只有未知页面路由显示「无法打开此地址」。401、503、响应无效及恢复焦点沿公共状态卡规则。 |
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
- `conversation-skill-control-files.spec.ts`：[对话 Skill 控制文件](#对话-skill-控制文件)在 1440×900 与 390×844 下
  各状态的可见元素、与已选 Skill 卡和错误行的对齐、字号、播报区与添加 / 重试 / 移除后的焦点。
- `conversation-files.spec.ts`：[对话会话文件附件](#对话会话文件附件)在 1440×900 与 390×844 下的行卡、名称可见、字号与颜色、
  拒绝原因与「重试」、单行说明、播报区与重试 / 移除后的焦点。
- `conversation-action-focus.spec.ts`：命令菜单「目录读取失败」的「重试」位置，「重新生成」挂起与受理后的焦点，
  [对话访问失效](#对话访问失效)后的焦点；`conversation-artifacts.spec.ts` 覆盖[对话结果文件预览](#对话结果文件预览)的读取态；
  `auth.spec.ts` 覆盖[侧栏退出登录](#侧栏退出登录)与「重新登录」确认会话已失效后的焦点（N10-1-01）。
- `conversation-feedback-lines.spec.ts`：[对话页状态说明行](#对话页状态说明行)在 1440×900 与 390×844 下的字号、对齐、
  播报角色与「核实原执行状态」后的焦点，以及模型设置不可重试失败行的字号与内缩（O8-01）。
- `access-states.spec.ts`：员工打开四个系统管理页的页头与「未授权」卡，Skill Hub 与设置页读取 401 的「重新登录」、
  确认会话期间、恢复后与会话已失效后的焦点（[管理与设置页的缺失状态](#管理与设置页的缺失状态)，#3292、#3327）。
- 恢复焦点（`hooks/use-recovery-focus.ts`）的同页查询串变化、交接一次与后台重绘（D2-59，#3388）：`admin-agents.spec.ts`、
  `audit.spec.ts`、`catalog-search.spec.ts`、`application-management.spec.ts`、`session-states.spec.ts`
  与 `conversation-routing.spec.ts` 中标注 `#3388` 的用例，两个视口，含请求挂起与失败两种结果。
- 焦点丢失兜底与用户发起读取的反馈（D2-59，#3419）：`my-agents-design.spec.ts`、`owner-configuration.spec.ts`、
  `management.spec.ts`、`personal-credential-narrow.spec.ts`、`application-management.spec.ts`、`admin-agents.spec.ts`、
  `audit.spec.ts`、`conversation-live.spec.ts` 与 `conversation-routing.spec.ts` 中标注 `#3419` 的用例，两个视口，
  含后台重读挂起、可重试失败、不可重试失败与恢复；触发与不触发条件的单元用例在 `use-recovery-focus.test.tsx`、`dialog.test.tsx`。
- 轮询与已显示内容后的不可重试失败（#3433）：`owner-configuration.spec.ts`、`management.spec.ts`、`conversation-routing.spec.ts`、
  `conversation-live.spec.ts`、`conversation-feedback-lines.spec.ts`、`connection-installation.spec.ts` 与 `my-agents-design.spec.ts`
  中标注 `#3433` 的用例，两个视口，含可重试失败、不可重试失败、读到终态与恢复；手写轮询的失败分类在 `background-read.test.ts`。

截图反映受控 API fixture，不证明 LDAP、真实模型、Kubernetes 或独立 Connection 验收。
数据条数、身份、模型选项、权限相关操作与导出样例的差异须以实际契约为准；
原型里的示例凭证、合成数据和演示入口不能作为生产能力移植。
测量通过仍须回读截图；PR 中记录绑定当前 head 的报告、视觉差异及人工结论。
