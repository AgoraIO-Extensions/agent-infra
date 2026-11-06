# ACK Agent 镜像缓存

本流程把 GHCR 镜像准备移到发布和部署阶段。缓存是镜像层快照，不保存用户会话、凭据或 PVC，
不等于 Session reserve。当前生产准入范围是 ECI Session Pod；ECS 上的 Agent 级 Workload
与 self-managed 服务不因此迁移到 ECI，也不宣称使用 ECI 缓存。

## 发布与部署

1. 正式 `Publish images` 成功后，独立 `ACK image cache plan` workflow 校验同 run/attempt 的六镜像
   index 回执，选择 `linux/amd64` child digest，只上传不可变 cache plan artifact；它不取得
   云身份、Kubernetes 凭据或 registry pull secret，也不创建缓存。
2. 部署入口设置 `ACK_IMAGE_CACHE_REQUIRED=true` 后，从同源 Runtime/模板 manifest 和已批准的
   Custom 最终镜像请求生成清单，由受控 ACK 运维机使用既有 kubeconfig/RBAC 调用
   `ImageCache` CR，复用集群内 `imagePullSecret`，等待 Ready 并实时回读。GitHub Action
   只是计划生成器，不是缓存执行器。
3. `all`、独立配置初始化、预检、配置发布和 provision 均在启用镜像前检查缓存。
   每次均实时查询 CR，并在全部组就绪后再次回读。回执必须匹配完整镜像集合与 source；
   磁盘旧回执不能代替实时查询。没有成功的当前回执，不发布新镜像配置。
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
24 组，每组最多 8 个不同镜像；创建前统计本 owner 的 CR，达到 48 份则拒绝创建。
同一集群的运维预热必须串行执行，避免并发检查超出预算。本流程不删除活动缓存。
缓存不设置自动到期或 LRU，以免仍在使用的精确 ID 被淘汰。退休版本由运维核对所有活动 Agent、
保留 Session 与回滚输入后，先移除准入登记，再按 owner 标签和精确 ID 清理；预热身份
不需要删除权限。缓存创建和使用产生云资源费用，应把这两个上限纳入部署预算。

已有 Failed/Expired 对象最多使用一个独立 retry generation，不覆盖旧对象；第二次失败仍
停止并保留失败回执。修复权限、网络或容量后由运维处理该失败 generation，再显式重试。

带 workspace snapshot 或其他 init 容器时，额外提供 `ACK_IMAGE_CACHE_EXTRA_GROUPS_FILE`，
声明实际 Pod 的完整镜像组合；不能只缓存主容器或 custom base。格式与下方计划相同。
新 Custom 镜像经正常部署入口预热并登记后才可创建 Session；绕过部署入口直接通过 API
采用未登记镜像，会被准入拒绝，不自动退回冷启动。

## 一次性运维身份配置

GitHub Environment `ack-image-cache` 仅用于受保护 `main` 生成计划 artifact，不需要 RAM OIDC。
缓存执行由 SRE/ACK 运维机完成：kubeconfig 的 Kubernetes RBAC 只允许目标集群的
`eci.alibabacloud.com` ImageCache create/get/list，registry 凭据留在集群 Secret，不进入
GitHub、repo、日志或 issue。该运维身份不需要 Kubernetes 业务 Pod 写权限、应用 Secret、
数据库或镜像删除权限。

普通发布触发计划生成；受控 ACK 运维机可通过 `ack-image-cache-prewarm.timer` 每 5 分钟轮询
成功的 plan workflow，下载同 run/attempt 的 artifact，再执行现有 `image-cache.ts` Kubernetes
backend。kubeconfig、`gh` 登录态和 registry Secret 都留在运维机；GitHub 不获得它们。
运维机只引用 Secret 名称，不读取凭据正文。CR 查询失败、缓存未 Ready 或拉取 Secret 无效时停止，
不冷拉绕过。轮询器按 run/attempt 和私有状态目录幂等，串行等待 Ready；失败保留脱敏 receipt，
每轮下载到独立临时目录、校验后持久化计划并清理下载目录，下一轮复用同名 CR，不创建副本。正常部署仍使用原有部署身份，读取旧 VAP 并更新准入所需权限保持不变。

## 运维端执行

### 自动轮询（推荐）

在受控运维机安装 Node 24、`gh`、`kubectl`，并让 `gh auth status` 使用只读 Actions artifact
读取权限。将 service/timer 安装到机器，不把 token、kubeconfig 或 Secret 写入仓库：

```bash
sudo install -m 0644 deploy/ack/ack-image-cache-prewarm.service /etc/systemd/system/
sudo install -m 0644 deploy/ack/ack-image-cache-prewarm.timer /etc/systemd/system/
sudo install -d -o agent-infra-ack -g agent-infra-ack -m 0700 /var/lib/agent-infra/ack-image-cache
sudo systemctl daemon-reload
sudo systemctl enable --now ack-image-cache-prewarm.timer
systemctl list-timers ack-image-cache-prewarm.timer
```

`/etc/agent-infra/ack-image-cache-prewarm.env` 至少包含：

```bash
ACK_AUTO_PREWARM_STATE_DIR=/var/lib/agent-infra/ack-image-cache
ACK_KUBECONFIG=/etc/agent-infra/hzacsagentprod01-cucc.config
GH_CONFIG_DIR=/etc/agent-infra/gh
ACK_NAMESPACE=agent-infra
ACK_IMAGE_PULL_SECRET=ack-ghcr-pull
ACK_IMAGE_CACHE_SIZE_GIB=30
ACK_IMAGE_CACHE_TIMEOUT_MS=1800000
ACK_IMAGE_CACHE_CONCURRENCY=3
```

以 `agent-infra-ack` 用户在 `/etc/agent-infra/gh` 完成一次 `gh auth login`（只读 Actions
artifact 权限）后再启动 timer。轮询器只处理受保护 `main` 上成功的 `ACK image cache plan` run，校验单一未过期 artifact、
source/digest plan 和 workflow attempt，然后调用 `ensure`。日志只输出状态、run/attempt、
source 和 cache 数量；计划和 receipt 写入 0700 状态目录。`systemctl start ack-image-cache-prewarm.service`
可手动运行一次，`journalctl -u ack-image-cache-prewarm.service` 可查看结果。

GitHub workflow 绿灯仍只代表 plan artifact 成功；systemd 服务成功且 receipt 为 Ready 才代表
预热完成。部署入口仍需实时 `check` 并通过严格准入，不能把轮询成功当作业务验收。

使用 Node.js 24，在受控代码 checkout 中执行。先核对 `ACK image cache plan` 运行来自本仓
受保护 main、结论成功，回读其触发的 Publish images run/attempt 和 source。以下变量由本次
已批准部署填入，不能从未验证的 artifact 自动决定目标集群或 source：

```bash
# CACHE_PLAN_RUN_ID / CACHE_PLAN_ATTEMPT 指计划 workflow 的 run/attempt。
# ACK_SOURCE_SHA 指批准发布的源码 SHA，不是 workflow 代码的 SHA。
umask 077
mkdir -p "$CACHE_PLAN_DIR"
gh run download "$CACHE_PLAN_RUN_ID" --repo AgoraIO-Extensions/agent-infra \
  --name "ack-cache-plan-$CACHE_PLAN_ATTEMPT" --dir "$CACHE_PLAN_DIR"
export ACK_SOURCE_SHA ACK_KUBECONFIG ACK_NAMESPACE
export ACK_IMAGE_PULL_SECRET=ack-ghcr-pull
node deploy/ack/image-cache.ts ensure \
  "$CACHE_PLAN_DIR/cache-plan.json" "$CACHE_PLAN_DIR/cache-ready.json"
node deploy/ack/image-cache.ts check \
  "$CACHE_PLAN_DIR/cache-plan.json" "$CACHE_PLAN_DIR/cache-checked.json"
```

`ensure` 创建或复用缓存并等待，`check` 只读且不会创建。失败回执包含安全错误码和已经完成的
组，不能用于启用新镜像。计划 artifact 不是 Ready 回执；即使预热成功，仍需通过正常部署入口
设置 `ACK_IMAGE_CACHE_REQUIRED=true`，从同源 manifest/Custom 请求生成完整计划并实时验证。
这一步会覆盖实际 Session 的 init/sidecar 镜像组合，并生成严格准入配置。单独运行 `ensure`
不会修改业务 Pod、Agent 配置或准入策略。

计划格式如下：

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

正式发布计划只选取同 source 发布回执中的 amd64 child digest；多架构 index 不作为缓存输入。
部署 manifest、Custom 镜像平台、Agent 配置和现有容量/模型准入仍由原 ACK 入口校验，
不以缓存成功替代。

## 验收与恢复

回读同 Pod UID 的实际 imageID、ECI 节点、`SuccessfulHitImageCache` 及精确镜像的
`Pulled ... already present`。部分命中、仍有 `Pulling`、事件缺失或缓存失败都不能算验收通过。
同时验证未知镜像被 VAP 拒绝、无效缓存 + Never 得到 `ErrImageNeverPull` 而没有冷拉取。
Pod 就绪与真实 Agent/模型结果分别记录。

缓存失败时先修复缓存，不删除准入或改回 IfNotPresent 绕过用户选择的启动门禁。新镜像只在
缓存重新 Ready、回执和准入映射更新后启用。现有运行中的 Agent 不因本流程失败被重启。

GitHub 发布成功只触发计划生成；尚未运行运维预热或部署入口时，不代表缓存已创建。
