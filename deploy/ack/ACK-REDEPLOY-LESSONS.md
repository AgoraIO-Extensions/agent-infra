# ACK 重部署案例与迁移顺序（脱敏）

这份记录对应 2026-10-27 至 2026-10-30 的 ACK 重部署演练。所有地址、账号、Token、Cookie、镜像 digest、
Agent ID、Secret 名和会话正文都保存在仓库外的私有 receipt；本文只记录可复用的因果关系。

## 已成功的链路

- 从 clean source checkout 固定源码 SHA，Platform、Worker、Runtime 和配置输入能在部署前绑定到同一来源。
- 从已有 ACK 只读采集 Helm values、Secret/ConfigMap 依赖和数据库输入，并生成 reuse/fresh capsule；fresh capsule 为管理员、Platform、Directory migration 和 Directory runtime 保留独立账号边界。
- 按 namespace/cluster UID、ownership label 和精确 Session ECI admission 对象执行破坏性清理；清理后能回读 namespace 已不存在。
- 空 namespace 重新创建后，API、Web、Worker、Directory 四个 Deployment 均能 rollout 到 `1/1`，HTTPS 根入口返回 `200`，匿名 Agents API 返回 `401`。
- 正式登录入口、API credential 签发、Relay billing、Relay `/models` 和真实 Codex Runtime model probe 均曾成功；Codex receipt 含 Runtime model fact、完成状态和实际回复 hash。
- 准备阶段的四个标准模板和两个自定义 ACP Agent 各完成三轮真实浏览器对话，18 轮均匹配 durable model completed facts，并通过刷新恢复和跨主体拒绝。该环境仍含独立更新的业务组件，不能作为同源完整清空重建的成功证据。

## 本轮完整清空重建

2026-10-29 13:50 UTC，运行源码 `192bb8c87ad4cfe5eb28e6b1e3617d8bd5dc2705` 的
一次完整 `all` 和独立现场审计均通过。正式镜像来自
[发布运行 40871922225](https://github.com/AgoraIO-Extensions/agent-infra/actions/runs/40871922225)，
八个 amd64 OCI 镜像分别核对来源与 Digest；镜像代理只改变拉取地址，原发布清单保留。
自定义镜像保留各自的基础源码与 overlay 来源，未改写为 Platform 源码。

旧平台 namespace、Session 调度策略及关联 PV 删除后，回读平台 namespace/PV 均为零。
新 namespace 和 installation ID 重新初始化数据库，三个角色、两个数据库和两项迁移 Job
通过；迁移 Pod 的归属、退出码与实际 imageID 均已核对。四个平台 Deployment 均为 `1/1`，
17 个声明配置对象的 52 个键与私有输入逐字节匹配。两个主体正式登录、个人 Relay Key
自动安装及回读、六份容量输入挂载均通过。

| Agent | 本轮业务结果 | 当前执行绑定 |
| --- | --- | --- |
| Codex | 三轮通过，模型 `gpt-5.6-sol` | 三个模型完成事实，当前 Session/Pod/imageID/ECI 匹配 |
| Claude | 三轮通过，模型 `deepseek-flash` | 同上 |
| OpenCode | 三轮通过，模型 `deepseek-flash` | 同上 |
| Pi | 三轮通过，模型 `deepseek-flash` | 同上 |
| 自定义 ACP r2 | 三轮通过，模型 `deepseek-flash` | 同上，保留独立自定义镜像来源 |
| 自定义 ACP r3 | 三轮通过，模型 `deepseek-flash` | 同上，保留独立自定义镜像来源 |
| 单服务自有入口 | HTTP 身份正反例、浏览器登录/后端交互/刷新/拒绝均通过 | 当前 Workload、Pod、Service、EndpointSlice、Ingress 和 imageID 匹配 |
| web/api 双服务自有入口 | 同上，两个服务均就绪 | 同上，入口与后端拓扑匹配 |

八次创建均首次返回 `201`，没有依赖重试或网关 `504`。六个对话 Agent 共 18 轮，逐轮保留
SSE、完成终态、刷新恢复和跨主体拒绝，并与同一 Execution 的 18 个 durable model completed
facts 对应。两个自有入口各验证匿名、伪造身份、错误凭证、无权凭证和允许访问五种 HTTP 情况，
再执行真实浏览器交互。全过程使用一次新安装的自动流程，没有中途手工修补集群状态。
其中十轮短回复的文本与终态同批到达，按既有 coalesced delivery 规则校验；本轮没有工具或
reasoning 事件，不据此扩展为工具、思考过程或全部逐帧增量渲染的验收。

此前“业务通过但 Session 位于 ECS”的运行、首次 ECI 观察窗口超时的运行，以及修复后的诊断
均独立保留；它们不回填本轮结果。该结果仅覆盖八 Agent 功能矩阵，不代签 #3295 网络策略
拒绝流量、长期闲置恢复或其他历史验收项。

脱敏证据索引保留如下 SHA-256；原始凭据、地址及普通会话正文仍仅在私有包中：

| 证据 | SHA-256 |
| --- | --- |
| 独立现场审计 | `515940f50a7f81a21d75616e67bf7f009007afebea60f56ac5e8f145445c070e` |
| 浏览器与模型汇总 | `21581652e78da5bfb28e27a27724a349ad4a5cf6d6a58ef6fd8d41b117afca53` |
| 六个业务 ECI 绑定 | `79e8032658ef1c8830fe04b5f5cae2fe70a4e4a28013f6f0735f50adc5beef82` |
| 性能汇总 | `017f30b780778ec40d801456bacc8089c73ed076f647b12f545c028c43cca9a2` |
| 证据文件索引 | `091cf0e352b38b0f4bf5f1ff0a3c249bd15e6c7aa843d4ba7eb6194122c0471f` |

## 本轮性能观察

以下均为这次有限负载的实测。资源采样共 2024 条，API/Worker 窗口 CPU 峰值约为
509/500m，接近配置的 500m 限制；内存峰值约为 148/332Mi，对应 512Mi 限制。
窗口样本不能证明 CPU 限流、生产尾延迟或并发容量。完整明细和未定 SLO 由 #3692 跟踪。

| 环节 | 本轮观察 | 解释边界 |
| --- | --- | --- |
| CI / 正式发布 | Heavy 56 分 28 秒；Platform amd64 8 分 34 秒、Runtime amd64 27 分 31 秒 | CI 记录测试 head，发布记录运行源码；并行任务不相加为用户延迟 |
| 完整 `all` | 约 59 分 36 秒 | 包含冷交付、迁移、创建和串行验收 |
| 两迁移 Job | Platform 269 秒、Directory 83 秒 | 包含 Pod 镜像拉取，不能视为 SQL 执行时长 |
| ECI 模板 Pod / 模型预检 | Pod 创建到 Ready 189–338 秒；模型阶段 4.765–14.102 秒 | 分别计时，冷镜像交付是优化候选 |
| 业务 Session / 首轮对话 | Pod 到 Ready 44–54 秒；点击到受理 61.6–66.5 秒、首文本 69.3–89.7 秒 | 六个新 Session；内部准备、排队、模型耗时未独立归因 |
| 后续轮对话 | 受理 0.226–0.448 秒，首文本 6.294–11.263 秒 | 十二轮同 Session 样本，非生产分位数 |
| 登录 / 授权 API | 登录 `204`，391 毫秒；会话/Agent 状态读取中位数 102/193 毫秒 | 登录一次，两个 API 各十次；均验证当前身份/状态 |
| Web / 自有入口 | 页面 LCP 观察 0.628–0.992 秒；入口按钮到后端结果 47–80 毫秒 | 每视口/入口三次，非现场 Core Web Vitals 合规 |
| Agent 记录到 Pod 创建 | 六对话 12.9–27.9 秒；单入口约 194 秒、双入口约 169 秒 | DB 时间戳不等于 HTTP 受理/提交时间；Pod 前等待仍需归因 |

首轮冷启动、自有入口创建前等待和 CPU 接近限制需要进一步分析；本轮没有通过增加观察
超时来宣称性能改善。功能验收通过与性能达标分别记录。

模板模型预检在 Pod Ready 后另写 `pod-startup.receipt.json`：绑定本次 job 的
source/template/image 和实际 Pod UID 哈希，记录创建、容器启动、Ready 及镜像拉取阶段。
临时 Pod 的 source 标签只用于本次观察归属，不替代已有镜像和模型来源校验。
`SuccessfulHitImageCache` 与 `ImageCacheNotFullMatch` 可以同时出现，不能据缓存命中事件
宣称没有下载；只有同 UID 的精确 `Pulled` 已存在消息才投影为 `imageAlreadyPresent=true`。
事件读取失败、缺少相关事件或时间无效时保留 unknown/null，不推断 cache miss、零耗时或性能达标。
收据不包含 Pod/Namespace 名、缓存 ID、原始事件消息或凭据；原模型、validation、capacity
收据及资源清理规则保持独立。

## 失败案例及修复规则

| 现象 | 根因 | 固化到工作流的规则 |
| --- | --- | --- |
| 发布日志含 Docker healthcheck 警告，被误判为构建失败 | 完整相位日志显示四模板已成功构建、探测及 push；实际退出在 RuntimeHost push，原命令又隐藏了 stderr | 按 build/probe/push/readback 分段归因；push 只输出固定错误类别和来源信息，不打印原始错误。出现警告不能代替定位退出命令，也不能以升级 Action 或重跑成功倒推根因 |
| 固定 Codex arm64 下载在连接建立阶段超时而失败 | Codex 安装器原来只做一次固定归档请求，没有对明确的连接中断保留总预算内的重试 | Codex 归档、法律文件和模型目录继续使用原始固定 URL 与摘要；仅对明确的连接错误做最多三次有界重试，HTTP/TLS/校验错误立即失败。不要把 Codex 下载成功推断成 OpenCode 或完整镜像构建成功 |
| 固定 OpenCode arm64 下载在收到部分归档后因连接被远端关闭而失败 | 安装器原来只做一次 fetch/arrayBuffer，未对可重试的 `UND_ERR_SOCKET` 保留总预算内的重试 | 固定版本、URL、TLS 和 SHA-256/SHA-512/可执行文件校验保持不变；仅对明确的连接中断做最多三次有界重试，丢弃部分字节，HTTP/TLS/校验错误立即失败。Hosted 构建与本地网络失败分开记录 |
| 模板能 push，已有 RuntimeHost package 却无法发布 | 不同 GHCR package 的来源关联和 Actions 写入权限可能不同；OCI source label 不会自动修复已有 package 的授权 | 核对目标 package 的仓库关联与 Actions 权限，镜像声明 source label；用 `smoke=true` 的独立标签实际执行四模板、RuntimeHost、自定义 base 和双架构索引。单个模板成功不能代替全链路成功 |
| 后续镜像失败后，已写出的模板收据也丢失 | artifact 上传步骤默认仅在前置步骤成功时执行 | 未取消的失败运行也保留部分收据，并按 attempt 隔离；索引 job 仍要求两个架构完整成功，部分收据只作诊断 |
| 使用包的 source 关联作为 Actions 权限门禁 | 仓库关联与显式 Actions Write 独立；未关联或首次发布不等于没有写权限 | 不把 metadata 回读当作权限判定；真实 push 验证写入，允许 package admin 仅授予目标仓库 Write |
| 发布清单通过预检，渲染入口却接受不同 source 的 Runtime | shell 与 renderer 各自维护不同解析逻辑，测试又可能在脏 checkout 提前退出 | 两入口复用同一 source/arch/schema 校验器；从干净 Git fixture 执行真实 plan，覆盖正式 nested 与旧 flat 清单和无效输入拒绝 |
| YAML 修改通过文本检查，发布工作流却无法解析 | block scalar 中混入了少于首行缩进的制表符 | 提交前执行 workflow policy 的 YAML 解析和 actionlint；`git diff --check` 不能代替语法校验 |
| 修改配置 Secret 后 API 仍使用旧 origin/模板状态 | Kubernetes Secret 投影更新不会重载已经启动的 Node 模块 | `bootstrap-inputs apply` 后显式滚动 API/Worker，并等待两者 rollout |
| 部署一段时间后四模板重新变成 `stale` | Real-runtime validation receipt 有有效期；旧 receipt 不能授权新部署 | 创建 Agent 前验证四份 receipt 的来源 SHA、镜像、Driver、revision、model、状态和剩余有效期 |
| 标准 API Agent 返回通用 `400` | 模型准入先于镜像准入，但请求 source 尚未有 image digest | 预镜像阶段只按受信 template identity 做 keyless admission；最终 image admission 仍绑定 exact digest |
| 用旧模板 receipt 继续部署新镜像 | receipt 只在 exact image/config tuple 下有效 | 不把历史 receipt、Pod Ready、fixture 或 `/models` 成功当成当前模板验证 |
| Runtime 探针成功，后续模板校验却报 `PREFLIGHT_UNBOUNDED` | 探针详细记录包含诊断字段，校验入口只接受固定字段集合 | 探针同时生成供校验使用的精简 receipt，生产端与校验端共享字段定义；保留详细记录和独立容量记录 |
| 新 receipt 在 Worker 校验通过，API 却把四模板判为 `unverified` | API 的旧 `model-catalog` 依赖不支持 receipt 的 provenance 字段，业务组件与工具版本不一致 | 发布时固定所有组件及其依赖来源，部署后调用实际 API 的模板 readiness 回读；不删除 provenance 字段迁就旧消费者 |
| 自定义镜像可运行且模型测量通过，Platform 创建却报 `OCI_CONFIG_INVALID` | 增量镜像导出成 Docker manifest，平台准入要求 OCI manifest/config/layer media types | 发布显式使用 `oci-mediatypes=true`，先回读远端 manifest/config 类型再做容量测量；格式转换后的新 digest 必须重新实测 |
| 四模板独立仓库可用，单服务 custom 成功，多服务却在准入阶段返回 `400` | 多服务依赖全局 custom 镜像仓库；旧 API 又强制标准模板也属于该仓库，部署为兼容四模板移除了全局值 | 显式模板仓库绑定按自己的 image/reference/Digest 校验，custom 单镜像和多服务继续限定全局仓库；通过真实 Registry 请求验证两条路径并存 |
| 多服务资源逐个符合 schema，API 仍返回 `400` | 提交了多个 YAML document；平台接收的是单个包含 `schemaVersion`、`entryServiceName` 和 `resources` 的 System Manifest | 验证实际提交的整个文档格式与拓扑，不能只校验解析后手工拼装的资源数组 |
| Node HTTPS 正常，严格客户端仍拒绝私有证书 | leaf 缺少 Authority Key Identifier，或 CA 缺少 Key Usage；叠加系统默认 OpenSSL 扩展还会生成重复扩展 | 用显式 CA/leaf 扩展配置生成证书，包含 CA Key Usage、SKI/AKI 和入口 SAN；发布前用严格链与 hostname 校验，不能关闭 TLS 验证 |
| 四模板 preflight 通过，API/Worker 仍未使用本轮验证与容量 | `all` 在 preflight 前部署配置，生成的新候选和容量记录没有自动回写消费者 | `runtime-inputs` 在 preflight 后发布声明的配置键并验证 rollout，再运行 mounted-capacity gate；不用手工复制或修改 Secret |
| 三个新 Runtime 镜像在 ECI 长时间 `Pulling` | 发布 manifest 可见不等于目标 ECI 节点实际可拉取 | 每个模板先创建独立 ECI preflight Pod；拉取、启动、模型调用任一步失败都停止整个流程 |
| 全部平台服务就绪，标准 Runtime preflight 在模型请求前失败 | 约 697 MiB 的冷镜像仍在正常拉取，旧脚本的固定 180 秒就绪预算已耗尽 | 私有 job 使用有界 `podReadyTimeoutSeconds`，默认 900 秒、范围 60–1800 秒；失败保存 `pod-ready` 阶段和脱敏状态，不能用预热后的旧成功替代新的完整演练 |
| 新 Worker 从发布仓库长时间拉取，Helm 等待超时 | 同一 Digest 经目标环境已批准的镜像代理能在 ECI 启动，直接拉取路径未完成 | 使用前比较代理 manifest 的真实字节 Digest、config/layer Digest，并回读目标 ECI imageID；保留原发布清单和目标拉取清单及映射证据，只调整仓库地址，不改变源码或 Digest |
| 从已有代理拉取输入包升级源码时，删除前校验发现旧 Digest 残留 | 输入更新器只映射 preflight 的代理完整引用，API 的模板配置仍引用原发布仓库；只替换独立 Digest 字段不能更新完整引用 | 同时依据保留的原发布清单和实际拉取引用生成映射，核对旧来源与 Digest，验证全部配置不再包含旧绑定后才写入新输入。保留失败日志，不删除旧环境或放宽来源校验 |
| 只看到 Web/API 健康就宣称完成 | 健康检查没有覆盖 Session、Runtime、模型、持久化和跨主体拒绝 | 业务验收必须包含真实 Session、`text.delta`、完成事件、刷新回读、隔离负例和自定义入口 probe |
| 四模板 ECI preflight 和十八轮业务对话均通过，但业务 Session 实际在 ECS | private values 保留了关闭的 `sessionRuntimeScheduling.enabled`；Worker 自身或独立 preflight 的 ECI placement 不会自动传递给 Session | 要求 ECI 的输入包在运行前断言开关与架构，渲染策略及绑定；最终按每个业务 Session 的实际 Pod UID、imageID 和 Node 标签回读，不能用 preflight 节点替代。原完整运行保留为业务通过、ECI 验收失败，不回填成功 |
| 八 Agent 已 ready，首个 ECI 对话在 `submit` 阶段超时 | 实际 Session Pod 冷启动约 62 秒，页面等其就绪后才发消息；浏览器观察器默认 30 秒先退出 | 只为首轮消息响应设置 180 秒单阶段观察上限；保留创建、后续轮与全部成功/隔离断言。真实 Chromium 31 秒准备回归证明旧探针失败、新探针完成三轮；当前 ECI 诊断也完成三轮模型事实。等待预算修复不等于冷启动性能优化，也不回填原失败完整运行 |
| 多服务已 ready，入口验收只留下通用失败，稍后同环境完整通过 | 客户端请求没有出现在目标 Ingress 日志，旧探针又丢失具体连接错误；不能据此断定 DNS、TLS 或业务故障 | HTTP 边界结果在断言前写入私有 receipt，保留白名单错误码和尝试次数；ACK 只对明确临时 DNS/连接错误最多等待两分钟，所有 HTTP、内容和 TLS 判定保持。诊断重试通过不回填原始完整部署结果 |
| Agent ready，但会话一直 `AGENT_STARTING` | 新模板 digest 没有相应容量 profile，verified capacity 为空 | `provision` 前检查每个目标的 image/resource/evidence 绑定与挂载 Secret；更新后经正式 lifecycle 刷新，不能直接改 DB |
| custom Agent Workload ready，Session 却报 `RUNTIME_CONFIGURATION_INVALID` | 镜像没有 Driver 默认值，Worker 只为 Agent Workload 注入了 `acp` | Session 也注入服务端已选择的 Driver；用没有镜像默认 Driver 的实际自定义镜像回归 |
| GET session 200，写接口却返回 401 | 直接 HTTP 探针遗漏了浏览器 Origin | 遵守浏览器写入的 Origin/CSRF 契约，保留具体失败阶段；不把协议错误归因于密码或 Cookie |
| 原 ACK 入口拒绝 `/auth/login`，本地配置可登录 | Web Nginx 未注入 API proxy token，并覆盖了外部 HTTPS 转发标记 | Web entrypoint 从声明 Secret 渲染 token，正确传递 HTTPS 标记；重建后必须通过正式登录、会话 Cookie 和授权 API 回读，不能只验证页面可打开，历史修复见 [ACK 部署记录](./ACK-E2E-DEPLOYMENT.md) |
| 密码正确但自动登录失败 | 对密码文件使用 `trim()` 会删除合法的首尾空格 | 保留密码空格，只按输入约定删除一个末尾 LF/CRLF，并用含空格密码测试真实 HTTP 提交字节 |
| 清空后四模板 preflight 和 Agent 创建都通过，Web 首条消息仍返回 `RESOURCE_UNAVAILABLE` | 创建请求恢复了 Agent 默认 Relay Key，但新数据库里当前用户的个人 Relay Key 未设置；标准模板 Web 执行按主体读取个人 Key | credential bootstrap 可声明私有 `personalRelayKeyFile`，在浏览器验收前通过正式个人 Key API 写入空状态并回读；已有 Key 保留。真实同一会话在补齐个人 Key 后由拒绝变为 `202`，不能把这类问题归因于密码 |
| 首项 Agent 创建报连接失败，后续创建连续 `503`，但稍后原 Agent 已存在 | 服务端真实模型验证允许 120 秒，本次创建实际约 72 秒；旧客户端 30 秒中断后继续发送请求，同一凭证行仍被原事务锁住，日志出现 `55P03`。入口 Nginx 也只有 60 秒等待预算，可能先返回 `504`。原幂等键重放能取回原 Agent | 创建使用五分钟总预算；明确连接故障、正式依赖 `503` 或网关 `504` 只用原 key/body/credential 有界重放。身份/TLS/契约错误立即失败，预算耗尽停止后续创建；状态恢复只读已绑定 Agent，不能换 key 重复创建或把诊断恢复写成原完整运行成功 |
| 重试 fixture 通过，正式 API 的 `503` 却不匹配重试条件 | fixture 与客户端同时假设嵌套 `error.code`，真实协议使用顶层 `code` | 直接复用 `PilotProtocolErrorV1Schema` 验证 `schemaVersion/code/retryable`；正例采用该契约，错误嵌套、不可重试及其他错误码均保留负例 |
| 登录与模型目录正常，Messages 模型回合却进入 `unknown` | 上游模型请求返回 `502 upstream_error`，目录可见不代表模型可执行 | 保留直接模型请求的 HTTP 状态与脱敏错误类型；真实 Runtime preflight 失败时停止验收，不替换成功记录或把问题归因于登录 |
| 模型 HTTP 状态为 `200`，Runtime 仍没有文本或完成事件 | SSE 只含 `message_start` 后紧接 `api_error`；实际 native adapter 回读确认上游过载 | 成功必须包含模型完成事实、文本和终态，不能只看 HTTP 状态；使用已批准 Key 的其他可用模型时，先经同一 native adapter 和完整模板 preflight 复验，再更新配置 |
| 自定义增量镜像的 revision label 看起来仍是旧源码 | OCI 配置继承基础镜像的 revision，后续 overlay 有自己的构建配方和最终 Digest | 分别保留继承的基础 revision、基础 Digest、overlay Dockerfile hash 和最终 OCI Digest；原容量 receipt 保持原字节，不把旧来源改写为最终 Platform 源码 |
| 新 custom Session 正常，旧失败 Pod 仍反复重启 | 新 Worker 校验新增 Driver，旧 Pod 配置与期望不一致；已停止会话的残留资源需要收敛 | 先回读 Store 的 `desired_state=stopped` 与 Agent/Session 归属，再按 Pod UID 和 resourceVersion 删除精确残留，等待 Worker 自行回读；不手工提升数据库状态 |
| 本地发布构建只报告退出码 1 | BuildKit 到 Docker Hub 的鉴权连接被重置，构建包装器隐藏了 stderr | 在仓库外保留权限受限的构建诊断；受控增量镜像须固定基镜像、源码与全部变化依赖，回读编译产物哈希，并明确区别于完整发布 manifest |
| 本地依赖安装成功，Docker 内构建仍在 pnpm 下载阶段超时 | 宿主机缓存命中与构建容器的实际网络/依赖下载是两条路径；该次构建没有产出成功镜像 | 保留具体失败阶段和私有日志；部署只消费正式 workflow 已成功发布并回读的同源 OCI manifest，不把宿主机安装成功或旧镜像当作这次 Docker 构建通过 |
| 本地基镜像解析约六分钟后报 `unable to lease content` | BuildKit 报本次缓存内容 lease 不存在；没有证据进一步断定谁清理了缓存 | 记录该次构建失败及来源，不把它归因于业务代码或改用浮动基镜像；保留共享构建环境，使用正式发布与目标镜像回读验证交付 |
| 跨用户 API/SSE 均拒绝且页面没有会话正文，浏览器验收仍失败 | Agent 不可见时页面使用新的无权访问卡，探针只匹配旧的会话失效提示 | 接受两种正式拒绝提示，继续验证 API/SSE 的 403/404、用户消息和助手正文不可见 |
| CI 一直重跑，验证无法结束 | 把 run 的 `updatedAt` 当成心跳，误取消仍在执行的长测试 | 查询当前 job/step；只有终态或明确失联证据才考虑重跑，禁止以轮询超时推断任务已经停止 |
| 仅修改部署 Markdown，却要求 Docker 构建或跳过文档检查 | 开发验证计划只识别固定文档目录，部署目录中的 Markdown 被当作部署代码 | 按 Markdown 文件类型选择格式/链接检查；真实部署脚本、清单、应用或依赖变更仍保留原门禁，见 #3694 |
| GitHub 显示纯文档 PR，CI 却跑全部代码任务 | CI 用 base/head 两点比较，落后 main 的分支把 main 独有代码算作删除 | 分类比较 PR merge base 到 head，并用真实分叉 Git 仓库回归；不能靠跳过 CI 或重跑掩盖比较范围错误，见 #3701 |
| 隔离 worktree 的 Harness 测试读到其他 worktree 的 source pin | 用例继承宿主默认状态目录，预期缺少 pin，实际读到已有环境的 pin | 测试使用自己的临时状态目录并确认外部 pin 未变；原失败记录与隔离复验分开，禁止删除真实环境的状态文件来让测试通过，见 #3703 |
| 移动端配置页后台重读测试偶发缩短 32px | 测试在 checkbox 更新后立即采样，父表单尚未提交草稿；随后移除“没有需要保存的变更”提示及间距 | 等待保存按钮可用且无变化提示消失，再采样高度/滚动/焦点；保持原断言，不加固定 sleep 或放宽误差 |
| Linux Hosted 浏览器偶发空白，审批控件超时；本地重复通过 | 当前失败记录确认 54 个脚本请求中 44 个为 `ERR_NETWORK_CHANGED`，React/Router 尚未创建、API 请求为零；时间落在另一 worker 的 PostgreSQL/MinIO 容器清理窗口，默认 bridge 的生命周期会改变宿主网络接口 | 普通浏览器测试保持两个 worker，使用真实 Docker 依赖的评测数据/流程/反馈测试放入独立项目，依次等待普通项目、真实桌面和真实移动端结束；保留全部视口、断言和超时。真实 Playwright 调度回归证明无重叠，完整 Hosted 运行再验证效果，不靠浏览器重载、忽略网络错误或放宽断言通过 |
| OpenCode 原生工具测试只有一次模型请求，或文件工具被误拒绝 | 完整参数通知异步到达；权限请求还可能携带 diff/provider 展示元数据，不能一律当作调用参数 | 固定 OpenCode 只采用公告参数并最多等一秒接收更新；通用 ACP 才用请求补齐空参数并拒绝冲突。异步授权后重新核对同一活动公告和参数。必须运行完整原生工具组，四种工具的通过不能代替 read/write/edit/Bash/apply_patch/WebSearch 验证 |
| 标准 Codex Agent 一直处于 `creating`，Worker 记录 `RUNTIME_READINESS_UNAVAILABLE` | ACK ECI 节点没有可用 Landlock ABI V5；旧 Worker 没有给标准 Codex Workload 注入 Worker-owned `container-boundary` 参数，Runtime 按默认 Landlock 启动并 fail closed | `policy.codexContainerBoundaryEnabled=true` 只允许 Worker 为标准专属 Pod 注入 `container-boundary`、`worker-v1`、可打印 scope 和 HMAC attestation；部署后必须回读 Pod env 和签名 readiness，不能用 healthz 或 Pod Ready 替代 |
| 破坏性重建数据库后 API credential 能签发，但 Agent API 仍返回 `401` 或 `400` | LDAP 登录会产生新的 canonical Platform user UUID；私有配置里残留的 `allowedPrincipals`、`apiSubjectMap` 或 custom admission principal 与当前主体不一致 | `bootstrap-login` 通过真实 session 生成私有身份候选和新浏览器 state；`runtime-inputs` 校验并发布已声明的身份键，API 私有配置显式映射原本批准的主体，再用当前 credential 验证 create/read |
| 修改 Worker/API Secret 后看起来配置已更新，但 Workload 仍沿用旧状态 | Secret 投影和 Store 中的 Workload UID/镜像/配置 revision 是独立事实；手工重建同名 StatefulSet 会触发 Worker ownership/UID conflict | 配置变更后只通过 Worker reconcile；若必须破坏性清理，删除 namespace/数据库或精确清理全部 owned Workload，再开始新一轮，不要手工复用旧 Agent ID |
| Custom Agent 有时 `available/ready`，有时 Runtime 立即 `RUNTIME_CONFIGURATION_INVALID` | custom 镜像、Secret schema 和实际 Runtime driver 是同一份准入事实；不同 digest 不能共用标准模板的 readiness 收据 | 每个 custom digest 单独做真实 Workload health/readiness 和模型回合；单个 custom 失败只保留为失败收据，不回填成另一个 custom 的成功 |
| 本地 preflight runner 从临时目录执行时找不到 `/private/packages/...` | runner 通过相对路径计算仓库根，复制到 `/private/tmp` 后路径闭包失效 | runner 必须从完整 clean worktree 执行，或显式传入来源 worktree；不要把临时复制的 runner 当作可移植收据 |
| 重跑 preflight 读到旧 checkpoint 或写 receipt 报 `EEXIST` | 私有 job 复用固定输出目录，但每次验证创建新 Pod | 先验证完整四模板 manifest/target 绑定，再每轮自动生成独立私有 job 与输出目录；保留旧证据和原输入 |
| Helm 本地渲染报 `sessionRuntimeScheduling` 不兼容，但目标 ACK 版本支持 | Helm client 默认 Kubernetes 版本与目标 Server 版本不同 | `render_manifest` 先读取目标 Server version，再用 `helm template --kube-version`；不要用本地默认版本判断目标能力 |
| 更新 private values 后 `bootstrap-inputs` 拒绝覆盖 | bootstrap 工具按 ownership 和 Secret 字节精确比较，既有 Secret 漂移是故障信号 | 身份候选、模板验证及容量使用 `runtime-inputs` 声明键的原地更新；其他配置变更另行核对旧/新字节与更新计划，不能以删除重建绕过漂移检查 |
| Helm 已切到新 Worker digest，但 Worker 立即 `Runtime image binding is unavailable` | capsule 中的 Worker/API `configuration.mjs` 仍绑定旧 RuntimeHost/模板 digest；Pod Ready 不能证明配置 tuple 已切换 | `deploy` 在 Helm 写入前运行 source configuration preflight；配置活动 digest 与 Platform/Runtime/template manifest 不一致时零写入失败，修复输入后再 rollout |
| `all` 首轮成功后，下一阶段仍读到旧 login blueprint、template validation 或 capacity | JSON 输入在 `.resolved-*` 中被安全隔离，生成结果没有自动回写 canonical capsule；后续 provision/validate 因身份或 evidence drift 失败 | 成功阶段只 promotion 声明的生成文件，并比较 canonical 初始字节；promotion 目标被外部改动时 fail closed，receipt 记录实际回写路径 |
| reserve readback 报 `CAPSULE_RESERVE_CONFIGURATION_MOUNT_INVALID`，但 ACK Worker Ready | chart 的 `PLATFORM_WORKER_DEPLOYMENT_MODULE` 指向 `deployment.mjs`，配置 Secret 通过 `configuration.mjs` subPath 挂载；旧 helper 只接受 module 直接等于 subPath | 同一只读 Secret volume 必须同时提供 deployment entrypoint 和 configuration subPath；readback 接受这两种合法 entrypoint 组合，仍拒绝外部 Secret 或可写挂载 |
| ACK ECI Worker 已 Ready，reserve/capacity readback 偶发 `ETIMEDOUT` | 进入容器并导入部署模块整体实测约 28 秒，尚未独立归因握手或模块加载；原 30 秒本地进程预算没有抖动余量 | 使用 60 秒有界进程预算和 45 秒 API 请求预算；这只是部署证据的容错上限，不代表 Session 冷启动达标。继续在 #3779/#3692 分阶段测量 |
| 直接调用 runtime-inputs 成功，capsule 路径却在 preflight 返回通用失败 | 直接诊断遗漏 reserve 参数；真实 caller 注入了 kubectl executor，reader 却仍要求另一个 kubeconfig，且未显式传 namespace | reader 使用同一个已配置 executor 并显式传 namespace；回归测试从 runtime-inputs 携带 reserve 的完整调用进入。不能删参数后把不同路径的通过当作修复 |
| 单阶段执行成功，下一次调用或搬迁后失败 | JSON promotion 把本轮解析目录绝对路径写进 canonical 输入；首次生成的模板索引未参与下一轮解析 | 回写时恢复包内路径 token，按实际绑定解析生成索引；搬迁测试移除原目录和旧解析副本后再读。disabled reserve 有独立 baseline 时仍须回读 live Secret |
| 配置预检失败后仍残留 namespace、Secret 和数据库 | all 原先在配置预检前执行 bootstrap，plan 也没有覆盖配置绑定 | plan/all/配置 bootstrap 共享写入前配置预检；修复后再继续。旧失败的部分安装与清理保留独立记录，不能声称零写入 |
| clean checkout 的模型探针报缺少 workspace dist | 只安装依赖，没有按准备步骤执行 build；这发生在本地 runner 加载阶段 | 在固定 clean checkout 执行 frozen install 和 build 后续跑探针，保留原失败；不能归因于 Runtime 镜像或业务模型 |
| 参数看似相同的命令一条成功、一条报 capsule invalid | 同一条 shell 命令里临时赋值变量，再用它展开参数，参数展开拿到的仍可能是旧值或空值 | 先独立赋值，再启动命令并传完整路径；不把 shell 参数差异归因于 Node strip-types 或 CA |
| fresh values 修改后出现占位镜像 | 诊断误用了通用 Helm chart 的 schema；ACK 入口实际使用 deploy/ack/chart | 从实际入口确认 chart，再按其 defaults 渲染；不能根据另一份 chart 的 lint 结果改写部署输入 |
| 新 Session 反复 `CONVERSATION_DISPATCH_UNAVAILABLE`，登录和 Agent readiness 正常 | 旧 completed execution 遗留 `retry_scheduled` outbox，或 disabled reserve 保留历史 accounting 却未为新 cold allocation 建 charge；Worker 每秒重放/回滚 claim | 清理旧安装时回读并收敛 completed execution 的 stale outbox；reserve disabled 新 cold path等待 #3827 修复合入，enabled/charged 路径继续保留 budget/CAS 检查；不要用重试放大旧条目 |
| 更新 API Secret 后登录短暂不可用 | ACK chart 的单副本 API Deployment 使用 `Recreate`，旧 Pod 会在新 Pod Ready 前被删除；Worker 不能简单复制零中断策略，因为单副本双 Worker 会并行 claim 队列 | API 使用 `RollingUpdate(maxUnavailable=0,maxSurge=1)`；Worker 保持 `Recreate` 直到有显式 drain/重复消费策略；每次 API rollout 都回读 Ready 连续性并用正式登录探针验证 |
| 运行中手工删除并重建 API/Worker 配置 Secret 后出现 `FailedMount: secret not found`，随后用户报告登录不可用 | Secret 空窗阻断 Pod 挂载；已有证据未把用户那次失败请求与该事件精确关联，恢复后的登录成功也不能反证当时原因 | 配置更新保留 Secret UID、校验归属与字节；在消费者 rollout 前后及新登录后重新核对。成功必须包含空 Cookie context 的正式新登录及 Session 回读；失败按写入阶段保留独立脱敏回执，不以旧 Cookie 可用代签新登录 |
| 四模板创建成功，custom Agent 在 Registry admission 返回 `400` 或 `401` | GHCR custom 包是 `internal` 且当前 API 没有可读该包的 approved credential/link；匿名标准镜像可用不代表 custom 包可读 | 保持 Registry admission fail-closed；为 custom 包准备已批准的 repository link 或 `read:packages` credential，回读 immutable manifest/config 后再创建，不把包改 public 或用 fixture 绕过 |
| 多服务 Agent 请求同时携带 `source.manifest` 与 `source.imageReference`，或把自有单服务镜像映射成 ACP 镜像 | 正式 API schema 的多服务、单镜像和 platform-adapter 分支互斥；历史成功请求不能证明当前迁移输入正确 | `all` 在任何集群写入前复用正式 `AgentApiCreationRequestV1Schema` 做离线 shape preflight；只输出固定错误码和 body hash。schema 通过仍需 Registry、Runtime、容量、真实入口和业务验收 |
| bootstrap database 阶段突然失败且没有业务错误 | private values 文件权限不是 0600，工具在读取前 fail closed | 所有 values、input、credential、body 和 storageState 文件保持当前用户拥有且权限 0600；目录 0700 |
| fresh 输入包在删除前被 Helm Schema 拒绝 | 新安装 ID 写入了不支持的 `bootstrap.installationId`，且数据库归属仍可能沿用旧值 | 新身份同时写入 bootstrap 输入的 `installationId` 与 values 的 `postgres.bootstrapInstallationId`；删除前渲染并核对 StatefulSet/PVC 的归属标签，不能放宽 Schema 或把旧 namespace 收养为新安装 |
| 工作流自己创建的 namespace 无法执行 `destroy` | 清理入口要求历史通用标签，bootstrap 只写当前 installation ID 标签 | 清理必须把 namespace 的 `bootstrap-id` 与计划的 installation ID 比较，同时保留 cluster/namespace UID、完整资源清单和两项删除确认；缺失或不同归属在删除前失败 |

## 可移植的一键顺序

输入包搬到其他机器后，原来的绝对路径会失效。`run-capsule.ts` 使用显式 JSON 模板列表和
包内路径 token，为每轮生成私有解析副本，再调用同一份 `redeploy.sh`；迁移时不用手工替换
多个文件中的本机目录，也不继承旧 shell 的 ACK 配置。原始凭证与历史证据保持私有。

短回复的文本帧和完成帧可能合并在同一个网络数据块中。浏览器探针在把数据交给应用前采样，
不能要求页面已经显示该数据块的内容。当前 probe 明确记录 coalesced delivery，继续检查当前
回复实际显示、事件顺序、持久化及隔离；分块交付仍要求终态前的增量渲染，不用人为延迟拆包制造证据。

自定义 Agent 的验收方式由创建请求的 `interactionMode` 决定：`platform-adapter` 必须验证
当前 Agent 的三轮 Platform 对话；`self-managed` 必须验证自己的应用入口。之前流程对所有
custom 都要求 HTML probe，导致 ACP 对话成功后仍无法结束；当前分派保留各自完整的检查。

把所有私有输入放在仓库外的 0600/0700 目录，然后使用同一组环境变量运行：

1. `plan`：校验 clean source、同源 amd64 image manifests、Helm 渲染、Server version 和所有私有依赖，不写集群。
2. `bootstrap-inputs`：读取并创建 namespace、Secret、ConfigMap，逐个回读字节和 ownership；已有内容漂移直接失败。
3. `bootstrap-database`（fresh 环境）：先启动数据库阶段，验证账号/数据库隔离，再运行 migrations 和 Platform。
4. `deploy`：Helm 部署并等待 API/Web/Worker/Directory rollout；回读 release revision、镜像和 Pod 证据。
5. `template-preflight`：对 codex、claude、opencode、pi 各创建一次带 exact image/config tuple 的 ECI Runtime Pod，使用真实 Relay 请求跑一轮模型，生成 candidate validation 和 preflight receipt；所有四份通过且留有有效期后才能继续。设置 `ACK_TEMPLATE_PREFLIGHT_JOBS_FILE` 后，`all` 会自动执行这一阶段并清理临时 Pod；也可以直接提供已经生成的 `ACK_TEMPLATE_VALIDATIONS_FILE`。
6. `bootstrap-login` / `runtime-inputs`（`all` 自动执行）：正式登录两个主体，发布当前身份、本轮模板验证和实测容量，回读 API/Worker 的配置并等待 rollout，再运行 mounted-capacity gate。
7. `bootstrap-credential`：使用当前登录 storageState 签发 API credential；声明 `personalRelayKeyFile` 时自动安装缺失的个人 Relay Key 并回读，已有 Key 保留。材料只写私有文件。
8. `provision`：按固定 Idempotency-Key 创建/重放四个标准 Agent 和自定义 Agent；创建前再次检查四份 template receipt。
9. `validate`：检查公网入口、四模板真实多轮/持久化/隔离验收和每个自定义 Agent 的真实入口；任一失败即失败。
10. `cleanup-plan` / `destroy`：只有明确破坏性确认、精确 UID 和完整 ownership 计划都匹配时才执行；完成后回读 namespace 和 Session admission 均不存在。Fresh 安装必须使用新的登录 session、API credential、Agent IDs 和真实 template receipts。

分享给他人的 receipt 只能包含状态、计数、来源 SHA 和 hash；不要包含原始路径、地址、凭证、
Cookie、Secret 内容、普通会话正文或未脱敏错误输出。
