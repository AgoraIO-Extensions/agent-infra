# ACK Agent 镜像缓存

本流程把 GHCR 镜像准备移到发布和部署阶段。缓存是镜像层快照，不保存用户会话、凭据或 PVC，
不等于 Session reserve。当前生产准入范围是 ECI Session Pod；ECS 上的 Agent 级 Workload
与 self-managed 服务不因此迁移到 ECI，也不宣称使用 ECI 缓存。

## 发布与部署

1. 正式 `Publish images` 成功后，独立 `ACK image cache` workflow 校验同 run/attempt 的六镜像
   index 回执，选择 `linux/amd64` child digest，按实际镜像集合幂等制作缓存。
2. 部署入口设置 `ACK_IMAGE_CACHE_REQUIRED=true` 后，从同源 Runtime/模板 manifest 和已批准的
   Custom 最终镜像请求生成清单。通过已有 `gh` 身份调用同一受保护 workflow，云端重新查询，
   使用它返回的同一批缓存 ID。本地不保存云密钥，不另造部署副本。
3. `all`、独立配置初始化、预检、配置发布和 provision 均在启用镜像前检查缓存。
   回执必须匹配完整镜像集合与 source，且在五分钟内。部署重复阶段可在该窗口内复用；超过
   窗口重新调用查询。没有成功的当前回执，不发布新镜像配置。
4. `deploy` 分两阶段：先保持现场旧准入不变完成 Helm/Worker rollout，核对全部 Worker Pod
   Ready、实际镜像 digest 且旧 Pod 已退出，再重新检查缓存并启用新准入。已有严格准入时
   遗漏开关直接拒绝部署，不能静默降级。
5. 在原 Session ECI 调度策略之外安装限定 namespace + `session-sandbox-v1` 标签的 CREATE
   准入。MAP 注入精确缓存 ID 并将全部普通及 init 容器设置为 `imagePullPolicy: Never`；VAP
   拒绝未知或不完整镜像集合。旧 Pod 不会被更新或重启。

显式缓存 ID 无效时，ECI 仍可能拉取镜像；仅配置 `eci-imc-id` 与 `eci-auto-imc=false` 不足以
保证严格模式。必须配合 `Never`，Worker 也必须先部署支持相同 immutable digest 的这项
更严格观测策略的版本；其他 Pod 身份和安全字段保持原校验。

当前/历史准入镜像集合会一起重新验证，避免旧 Agent 恢复和回滚版本失去缓存。每份计划最多
24 组，每组最多 8 个不同镜像；云端本流程缓存最多 48 份，超预算拒绝创建，不删除活动缓存。
缓存不设置自动到期或 LRU，以免仍在使用的精确 ID 被淘汰。退休版本由运维核对所有活动 Agent、
保留 Session 与回滚输入后，先移除准入登记，再按 owner 标签和精确 ID 清理；本流程云身份
没有删除权限。缓存创建和使用产生云资源费用，应把这两个上限纳入部署预算。

已有 Failed/Expired 对象最多使用一个独立 retry generation，不覆盖旧对象；第二次失败仍
停止并保留失败回执。修复权限、网络或容量后由运维处理该失败 generation，再显式重试。

带 workspace snapshot 或其他 init 容器时，额外提供 `ACK_IMAGE_CACHE_EXTRA_GROUPS_FILE`，
声明实际 Pod 的完整镜像组合；不能只缓存主容器或 custom base。格式与下方计划相同。
新 Custom 镜像经正常部署入口预热并登记后才可创建 Session；绕过部署入口直接通过 API
采用未登记镜像，会被准入拒绝，不自动退回冷启动。

## 一次性身份配置

云身份边界以[开发工作流 §10.1](../../docs/architecture/SPEC-ai-native-development-workflow.md#101-ack-镜像缓存部署)为准。

- 建立 GitHub Environment `ack-image-cache`，deployment branch policy 仅允许受保护 `main`。
- RAM OIDC issuer 为 `https://token.actions.githubusercontent.com`，audience 为 `sts.aliyuncs.com`；
  trust 的 subject 精确限制为 `repo:AgoraIO-Extensions/agent-infra:environment:ack-image-cache`。
- 角色只允许杭州缓存的 `eci:CreateImageCache`、`eci:DescribeImageCaches`，不授予 Kubernetes、
  应用 Secret、数据库或镜像删除权限。按云 API 的关联权限要求校验，不添加管理员策略。
- Environment variables：`ACK_CACHE_OIDC_PROVIDER_ARN`、`ACK_CACHE_ROLE_ARN`、
  `ACK_CACHE_VSWITCH_ID`、`ACK_CACHE_SECURITY_GROUP_ID`；可设置 `ACK_IMAGE_CACHE_SIZE_GIB`
  （20–100，默认 30）。交换机必须能通过受控出口访问 GHCR 镜像和 blob 地址。
- GitHub 自身的短期 package-read token 仅传给云端镜像制作请求，凭据不进入日志、回执或 Git。
  带云身份的代码来自本次默认分支 workflow SHA；发布 source SHA 仅作数据，不用于执行 checkout。

普通发布自动触发；需要复核某次发布时，在 main 运行 `ack-image-cache.yml`，传入
`publish_run_id` 和 `publish_attempt`。本地部署使用受保护的 `deployment_plan` 输入，内容
仅包含本仓 GHCR 不可变镜像引用，不允许 URL、脚本、凭据或任意仓库。

```json
{
  "schemaVersion": 1,
  "sourceSha": "0123456789abcdef0123456789abcdef01234567",
  "platform": "linux/amd64",
  "groups": [[
    "ghcr.io/agoraio-extensions/agent-infra/agent-runtime-codex@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  ]]
}
```

云步骤还回读 OCI manifest/config 摘要和架构，拒绝把 multi-arch index 当成 amd64 child。
源 manifest、Agent 配置和现有容量/模型准入仍由原 ACK 入口校验，不以缓存成功替代。

## 验收与恢复

回读同 Pod UID 的实际 imageID、ECI 节点、`SuccessfulHitImageCache` 及精确镜像的
`Pulled ... already present`。部分命中、仍有 `Pulling`、事件缺失或缓存失败都不能算验收通过。
同时验证未知镜像被 VAP 拒绝、无效缓存 + Never 得到 `ErrImageNeverPull` 而没有冷拉取。
Pod 就绪与真实 Agent/模型结果分别记录。

缓存失败时先修复缓存，不删除准入或改回 IfNotPresent 绕过用户选择的启动门禁。新镜像只在
缓存重新 Ready、回执和准入映射更新后启用。现有运行中的 Agent 不因本流程失败被重启。

`image-cache.ts ensure/check` 的 Kubernetes CR 后端仅供显式隔离诊断或首次引导验证；它不会
作为正式发布/部署链路的备用成功路径。其 owner、缓存和诊断资源须单独记录并清理。
