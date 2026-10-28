# ACK 重部署案例与迁移顺序（脱敏）

这份记录对应 2026-10-27 的 ACK 重部署演练。所有地址、账号、Token、Cookie、镜像 digest、
Agent ID、Secret 名和会话正文都保存在仓库外的私有 receipt；本文只记录可复用的因果关系。

## 已成功的链路

- 从 clean source checkout 固定源码 SHA，Platform、Worker、Runtime 和配置输入能在部署前绑定到同一来源。
- 从已有 ACK 只读采集 Helm values、Secret/ConfigMap 依赖和数据库输入，并生成 reuse/fresh capsule；fresh capsule 为管理员、Platform、Directory migration 和 Directory runtime 保留独立账号边界。
- 按 namespace/cluster UID、ownership label 和精确 Session ECI admission 对象执行破坏性清理；清理后能回读 namespace 已不存在。
- 空 namespace 重新创建后，API、Web、Worker、Directory 四个 Deployment 均能 rollout 到 `1/1`，HTTPS 根入口返回 `200`，匿名 Agents API 返回 `401`。
- 正式登录入口、API credential 签发、Relay billing、Relay `/models` 和真实 Codex Runtime model probe 均曾成功；Codex receipt 含 Runtime model fact、完成状态和实际回复 hash。

## 失败案例及修复规则

| 现象 | 根因 | 固化到工作流的规则 |
| --- | --- | --- |
| 修改配置 Secret 后 API 仍使用旧 origin/模板状态 | Kubernetes Secret 投影更新不会重载已经启动的 Node 模块 | `bootstrap-inputs apply` 后显式滚动 API/Worker，并等待两者 rollout |
| 部署一段时间后四模板重新变成 `stale` | Real-runtime validation receipt 有有效期；旧 receipt 不能授权新部署 | 创建 Agent 前验证四份 receipt 的来源 SHA、镜像、Driver、revision、model、状态和剩余有效期 |
| 标准 API Agent 返回通用 `400` | 模型准入先于镜像准入，但请求 source 尚未有 image digest | 预镜像阶段只按受信 template identity 做 keyless admission；最终 image admission 仍绑定 exact digest |
| 用旧模板 receipt 继续部署新镜像 | receipt 只在 exact image/config tuple 下有效 | 不把历史 receipt、Pod Ready、fixture 或 `/models` 成功当成当前模板验证 |
| Runtime 探针成功，后续模板校验却报 `PREFLIGHT_UNBOUNDED` | 探针详细记录包含诊断字段，校验入口只接受固定字段集合 | 探针同时生成供校验使用的精简 receipt，生产端与校验端共享字段定义；保留详细记录和独立容量记录 |
| 新 receipt 在 Worker 校验通过，API 却把四模板判为 `unverified` | API 的旧 `model-catalog` 依赖不支持 receipt 的 provenance 字段，业务组件与工具版本不一致 | 发布时固定所有组件及其依赖来源，部署后调用实际 API 的模板 readiness 回读；不删除 provenance 字段迁就旧消费者 |
| 自定义镜像可运行且模型测量通过，Platform 创建却报 `OCI_CONFIG_INVALID` | 增量镜像导出成 Docker manifest，平台准入要求 OCI manifest/config/layer media types | 发布显式使用 `oci-mediatypes=true`，先回读远端 manifest/config 类型再做容量测量；格式转换后的新 digest 必须重新实测 |
| 四模板 preflight 通过，API/Worker 仍未使用本轮验证与容量 | `all` 在 preflight 前部署配置，生成的新候选和容量记录没有自动回写消费者 | `runtime-inputs` 在 preflight 后发布声明的配置键并验证 rollout，再运行 mounted-capacity gate；不用手工复制或修改 Secret |
| 三个新 Runtime 镜像在 ECI 长时间 `Pulling` | 发布 manifest 可见不等于目标 ECI 节点实际可拉取 | 每个模板先创建独立 ECI preflight Pod；拉取、启动、模型调用任一步失败都停止整个流程 |
| 只看到 Web/API 健康就宣称完成 | 健康检查没有覆盖 Session、Runtime、模型、持久化和跨主体拒绝 | 业务验收必须包含真实 Session、`text.delta`、完成事件、刷新回读、隔离负例和自定义入口 probe |
| Agent ready，但会话一直 `AGENT_STARTING` | 新模板 digest 没有相应容量 profile，verified capacity 为空 | `provision` 前检查每个目标的 image/resource/evidence 绑定与挂载 Secret；更新后经正式 lifecycle 刷新，不能直接改 DB |
| custom Agent Workload ready，Session 却报 `RUNTIME_CONFIGURATION_INVALID` | 镜像没有 Driver 默认值，Worker 只为 Agent Workload 注入了 `acp` | Session 也注入服务端已选择的 Driver；用没有镜像默认 Driver 的实际自定义镜像回归 |
| GET session 200，写接口却返回 401 | 直接 HTTP 探针遗漏了浏览器 Origin | 遵守浏览器写入的 Origin/CSRF 契约，保留具体失败阶段；不把协议错误归因于密码或 Cookie |
| 密码正确但自动登录失败 | 对密码文件使用 `trim()` 会删除合法的首尾空格 | 保留密码空格，只按输入约定删除一个末尾 LF/CRLF，并用含空格密码测试真实 HTTP 提交字节 |
| 登录与模型目录正常，Messages 模型回合却进入 `unknown` | 上游模型请求返回 `502 upstream_error`，目录可见不代表模型可执行 | 保留直接模型请求的 HTTP 状态与脱敏错误类型；真实 Runtime preflight 失败时停止验收，不替换成功记录或把问题归因于登录 |
| 新 custom Session 正常，旧失败 Pod 仍反复重启 | 新 Worker 校验新增 Driver，旧 Pod 配置与期望不一致；已停止会话的残留资源需要收敛 | 先回读 Store 的 `desired_state=stopped` 与 Agent/Session 归属，再按 Pod UID 和 resourceVersion 删除精确残留，等待 Worker 自行回读；不手工提升数据库状态 |
| 本地发布构建只报告退出码 1 | BuildKit 到 Docker Hub 的鉴权连接被重置，构建包装器隐藏了 stderr | 在仓库外保留权限受限的构建诊断；受控增量镜像须固定基镜像、源码与全部变化依赖，回读编译产物哈希，并明确区别于完整发布 manifest |
| 跨用户 API/SSE 均拒绝且页面没有会话正文，浏览器验收仍失败 | Agent 不可见时页面使用新的无权访问卡，探针只匹配旧的会话失效提示 | 接受两种正式拒绝提示，继续验证 API/SSE 的 403/404、用户消息和助手正文不可见 |
| CI 一直重跑，验证无法结束 | 把 run 的 `updatedAt` 当成心跳，误取消仍在执行的长测试 | 查询当前 job/step；只有终态或明确失联证据才考虑重跑，禁止以轮询超时推断任务已经停止 |
| 标准 Codex Agent 一直处于 `creating`，Worker 记录 `RUNTIME_READINESS_UNAVAILABLE` | ACK ECI 节点没有可用 Landlock ABI V5；旧 Worker 没有给标准 Codex Workload 注入 Worker-owned `container-boundary` 参数，Runtime 按默认 Landlock 启动并 fail closed | `policy.codexContainerBoundaryEnabled=true` 只允许 Worker 为标准专属 Pod 注入 `container-boundary`、`worker-v1`、可打印 scope 和 HMAC attestation；部署后必须回读 Pod env 和签名 readiness，不能用 healthz 或 Pod Ready 替代 |
| 破坏性重建数据库后 API credential 能签发，但 Agent API 仍返回 `401` 或 `400` | LDAP 登录会产生新的 canonical Platform user UUID；私有配置里残留的 `allowedPrincipals`、`apiSubjectMap` 或 custom admission principal 与当前主体不一致 | `bootstrap-login` 通过真实 session 生成私有身份候选和新浏览器 state；`runtime-inputs` 校验并发布已声明的身份键，API 私有配置显式映射原本批准的主体，再用当前 credential 验证 create/read |
| 修改 Worker/API Secret 后看起来配置已更新，但 Workload 仍沿用旧状态 | Secret 投影和 Store 中的 Workload UID/镜像/配置 revision 是独立事实；手工重建同名 StatefulSet 会触发 Worker ownership/UID conflict | 配置变更后只通过 Worker reconcile；若必须破坏性清理，删除 namespace/数据库或精确清理全部 owned Workload，再开始新一轮，不要手工复用旧 Agent ID |
| Custom Agent 有时 `available/ready`，有时 Runtime 立即 `RUNTIME_CONFIGURATION_INVALID` | custom 镜像、Secret schema 和实际 Runtime driver 是同一份准入事实；不同 digest 不能共用标准模板的 readiness 收据 | 每个 custom digest 单独做真实 Workload health/readiness 和模型回合；单个 custom 失败只保留为失败收据，不回填成另一个 custom 的成功 |
| 本地 preflight runner 从临时目录执行时找不到 `/private/packages/...` | runner 通过相对路径计算仓库根，复制到 `/private/tmp` 后路径闭包失效 | runner 必须从完整 clean worktree 执行，或显式传入来源 worktree；不要把临时复制的 runner 当作可移植收据 |
| 重跑 preflight 读到旧 checkpoint 或写 receipt 报 `EEXIST` | 私有 job 复用固定输出目录，但每次验证创建新 Pod | 先验证完整四模板 manifest/target 绑定，再每轮自动生成独立私有 job 与输出目录；保留旧证据和原输入 |
| Helm 本地渲染报 `sessionRuntimeScheduling` 不兼容，但目标 ACK 版本支持 | Helm client 默认 Kubernetes 版本与目标 Server 版本不同 | `render_manifest` 先读取目标 Server version，再用 `helm template --kube-version`；不要用本地默认版本判断目标能力 |
| 更新 private values 后 `bootstrap-inputs` 拒绝覆盖 | bootstrap 工具按 ownership 和 Secret 字节精确比较，既有 Secret 漂移是故障信号 | 对 private 配置变更先删除并重建同一安装拥有的 Secret；不要用 `kubectl apply` 覆盖，也不要把漂移对象收养 |
| bootstrap database 阶段突然失败且没有业务错误 | private values 文件权限不是 0600，工具在读取前 fail closed | 所有 values、input、credential、body 和 storageState 文件保持当前用户拥有且权限 0600；目录 0700 |

## 可移植的一键顺序

自定义 Agent 的验收方式由创建请求的 `interactionMode` 决定：`platform-adapter` 必须验证
当前 Agent 的三轮 Platform 对话；`self-managed` 必须验证自己的应用入口。之前流程对所有
custom 都要求 HTML probe，导致 ACP 对话成功后仍无法结束；当前分派保留各自完整的检查。

把所有私有输入放在仓库外的 0600/0700 目录，然后使用同一组环境变量运行：

1. `plan`：校验 clean source、同源 amd64 image manifests、Helm 渲染、Server version 和所有私有依赖，不写集群。
2. `bootstrap-inputs`：读取并创建 namespace、Secret、ConfigMap，逐个回读字节和 ownership；已有内容漂移直接失败。
3. `bootstrap-database`（fresh 环境）：先启动数据库阶段，验证账号/数据库隔离，再运行 migrations 和 Platform。
4. `deploy`：Helm 部署并等待 API/Web/Worker/Directory rollout；回读 release revision、镜像和 Pod 证据。
5. `template-preflight`：对 codex、claude、opencode、pi 各创建一次带 exact image/config tuple 的 ECI Runtime Pod，使用真实 Relay 请求跑一轮模型，生成 candidate validation 和 preflight receipt；所有四份通过且留有有效期后才能继续。设置 `ACK_TEMPLATE_PREFLIGHT_JOBS_FILE` 后，`all` 会自动执行这一阶段并清理临时 Pod；也可以直接提供已经生成的 `ACK_TEMPLATE_VALIDATIONS_FILE`。
6. `runtime-inputs`（`all` 自动执行）：发布本轮模板验证和实测容量，回读 API/Worker 的配置并等待 rollout，再运行 mounted-capacity gate。
7. `bootstrap-credential`：使用真实浏览器 storageState 签发一次性 API credential；材料只写私有文件。
8. `provision`：按固定 Idempotency-Key 创建/重放四个标准 Agent 和自定义 Agent；创建前再次检查四份 template receipt。
9. `validate`：检查公网入口、四模板真实多轮/持久化/隔离验收和每个自定义 Agent 的真实入口；任一失败即失败。
10. `cleanup-plan` / `destroy`：只有明确破坏性确认、精确 UID 和完整 ownership 计划都匹配时才执行；完成后回读 namespace 和 Session admission 均不存在。Fresh 安装必须使用新的登录 session、API credential、Agent IDs 和真实 template receipts。

分享给他人的 receipt 只能包含状态、计数、来源 SHA 和 hash；不要包含原始路径、地址、凭证、
Cookie、Secret 内容、普通会话正文或未脱敏错误输出。
