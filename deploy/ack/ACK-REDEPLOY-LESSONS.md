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
| 三个新 Runtime 镜像在 ECI 长时间 `Pulling` | 发布 manifest 可见不等于目标 ECI 节点实际可拉取 | 每个模板先创建独立 ECI preflight Pod；拉取、启动、模型调用任一步失败都停止整个流程 |
| 只看到 Web/API 健康就宣称完成 | 健康检查没有覆盖 Session、Runtime、模型、持久化和跨主体拒绝 | 业务验收必须包含真实 Session、`text.delta`、完成事件、刷新回读、隔离负例和自定义入口 probe |

## 可移植的一键顺序

把所有私有输入放在仓库外的 0600/0700 目录，然后使用同一组环境变量运行：

1. `plan`：校验 clean source、同源 amd64 image manifests、Helm 渲染、Server version 和所有私有依赖，不写集群。
2. `bootstrap-inputs`：读取并创建 namespace、Secret、ConfigMap，逐个回读字节和 ownership；已有内容漂移直接失败。
3. `bootstrap-database`（fresh 环境）：先启动数据库阶段，验证账号/数据库隔离，再运行 migrations 和 Platform。
4. `deploy`：Helm 部署并等待 API/Web/Worker/Directory rollout；回读 release revision、镜像和 Pod 证据。
5. `template-preflight`：对 codex、claude、opencode、pi 各创建一次带 exact image/config tuple 的 ECI Runtime Pod，使用真实 Relay 请求跑一轮模型，生成 candidate validation 和 preflight receipt；所有四份通过且留有有效期后才能继续。设置 `ACK_TEMPLATE_PREFLIGHT_JOBS_FILE` 后，`all` 会自动执行这一阶段并清理临时 Pod；也可以直接提供已经生成的 `ACK_TEMPLATE_VALIDATIONS_FILE`。
6. `bootstrap-credential`：使用真实浏览器 storageState 签发一次性 API credential；材料只写私有文件。
7. `provision`：按固定 Idempotency-Key 创建/重放四个标准 Agent 和自定义 Agent；创建前再次检查四份 template receipt。
8. `validate`：检查公网入口、四模板真实多轮/持久化/隔离验收和每个自定义 Agent 的真实入口；任一失败即失败。
9. `cleanup-plan` / `destroy`：只有明确破坏性确认、精确 UID 和完整 ownership 计划都匹配时才执行；完成后回读 namespace 和 Session admission 均不存在。

分享给他人的 receipt 只能包含状态、计数、来源 SHA 和 hash；不要包含原始路径、地址、凭证、
Cookie、Secret 内容、普通会话正文或未脱敏错误输出。
