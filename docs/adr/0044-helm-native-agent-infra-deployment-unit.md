# ADR-0044：采用 Helm-native `agent-infra` 部署单元

- 状态：Proposed（随部署单元变更文档 PR 评审）
- 日期：2026-11-18

## 背景

现有生产 lane 使用 namespace/release `agent-infra-d-ws-1103`。Platform API/Worker 的配置模块由 Helm 外的
发布脚本创建或替换，多个 bootstrap、preflight、runtime-inputs 和发布脚本分别维护自己的边界；部分入口还会
通过 `--no-hooks`、`--post-renderer` 或 release 内对象重建来完成定向变更。这种链路无法把配置 Secret、迁移
hooks、镜像来源、release revision 和回滚统一绑定，也不适合建立一条可重复的正式生产 lane。

上段关于旧脚本入口的细节是 Helm source snapshot 的源码记录，不是本仓库的现场观测；生产采用仍需 Helm owner
按当前 plan/CAS 和现场回读确认。

Helm 仓库的 `docs/superpowers/specs/2026-11-17-agent-infra-helm-native-lane-design.md` 记录了新 lane 的
只读核查和演练结论：正式 namespace/release 均为 `agent-infra`，chart 接管 API/Worker 配置 Secret，
部署命令使用 `helm upgrade --install --atomic --wait` 并保持 hooks；用户选择 A1，不迁移旧 lane 数据，
旧 lane 停用后保留 3–7 天。当前不可变 source pointer 是 Helm 仓库
私有 Helm 部署仓库 的 commit
`c3156272c7aaa09d8896e7f2b71046a6d68d95e1`（PR #169 merge），文件
`docs/superpowers/specs/2026-11-17-agent-infra-helm-native-lane-design.md`，Git blob
`542c4389ee6a2b35093d58707422b52ca0b7c522`，文件 SHA-256
`b93af1da087d977436ec0a7add30742b17e6dcf2a8d4658e2115c0d1ee5ed174`。设计文档第 1、2、3、6、7、10 节分别
支持 namespace/release、chart Secret、hooks/命令、旧脚本现状、A1 和 3–7 天窗口；旧入口的
`--no-hooks`/`--post-renderer` 实例可在同一 commit 的 `agent-infra-ack/scripts/publish-platform-code.mts:1067-1074,1154,1324,1351,1399`
和 `agent-infra-ack/scripts/publish-api-resources.mts:741,856,920` 回读。本 ADR 只记录 agent-infra 工程边界和取舍。

## 决定

1. 把 namespace/release `agent-infra` 作为正式 Helm-native 部署单元。Platform、Worker、Directory、迁移
   hooks 及其 chart 持有的配置 Secret 在同一 release 中管理；Secret 内容由私有部署输入提供，敏感值不进入 Git。
2. 正式安装和升级唯一使用 `helm upgrade --install agent-infra ... --namespace agent-infra --atomic --wait`。
   Platform 与 Directory 迁移 hooks 保持启用；发布器不得用 `--no-hooks`、`--post-renderer`、`--reuse-values`、
   临时 `--set` 或 `kubectl patch/replace` 绕开 chart。
3. 新 lane 验收时使用独立 host；切换生产 host 由具名 owner 窗口显式放行，并在写入前后核对 cluster、namespace、
   release、source、镜像 Digest、配置 Secret UID/RV 和迁移状态。
4. 采用 A1：切换不复制或迁移旧 lane 的数据库、Agent、Session、消息、快照或 PVC。用户在新 lane 重新登录并
   重新创建资源。旧 lane `agent-infra-d-ws-1103` 停用后保留 3–7 天，再由单独的下线流程决定处理。
5. `helm rollback` 只恢复新 `agent-infra` release 自身的 revision、配置 Secret 和迁移状态，不接管旧 lane 数据，
   不删除旧 namespace 对象，不把旧 lane 的回滚当成数据恢复。

## 取舍

- **统一 chart 管理 Secret vs 保留脚本外置 Secret：** 统一管理可绑定 values、Secret 引用、release revision 和
  rollback，降低多脚本漂移；代价是 chart/release history 会保存 Secret 元数据和引用关系，必须继续使用私有值文件、
  严格文件权限和现有凭据策略。
- **新 namespace/数据库 vs 复用旧 lane：** 独立单元避免 outbox lease、Agent 调谐和 PVC 归属互相影响，能清楚回滚；
  代价是 A1 不迁移数据，用户需要重新登录并重新创建 Agent，旧 lane 需要短期保留并承担并行资源成本。
- **保留 hooks vs 现有部分脚本跳过 hooks：** hooks 让 Platform/Directory 迁移顺序成为 chart 合同并可由 `--atomic`
  统一处理；代价是迁移资源、超时和回滚必须纳入每次发布验证，不能依靠 operator 事后补写。
- **保留旧 lane 3–7 天 vs 立即下线：** 保留窗口支持只读核对和回滚决策；代价是旧 namespace/PVC/数据库仍需按数据政策和
  负责人确认管理，窗口期不能把旧数据当成新 lane 的事实。

## 回滚与恢复

1. 新 lane 单次升级失败由 `--atomic` 恢复本次 `agent-infra` release revision；owner 回读 release、Pod、镜像、配置
   Secret UID/RV 和迁移状态，记录失败原因。
2. 已完成的迁移只能按兼容迁移和 Helm release history 回滚；若迁移不可逆，暂停新 lane 后按迁移文档执行恢复，不能
   通过 Git revert 直接让旧代码重跑未知迁移历史。
3. 生产 host 切换失败时，将 host/入口恢复到原 owner 批准的状态；不触碰 `agent-infra-d-ws-1103` 数据对象。
4. 旧 lane 的停用、3–7 天保留和最终下线是独立现场变更，必须由 owner 在独立写窗口执行；本 ADR 和源码 PR 不授权任何
   namespace、release、DNS、Ingress、Secret、DB 或 PVC 写入。

## 待确认项

- Helm-native lane 的最终 values、source lock、镜像 Digest、namespace bootstrap-id、ClusterIssuer/Ingress 参数和
  Connection consumer 登记，均以 Helm owner 的当前 plan/CAS 和现场回读为准。
- 旧 lane 保留窗口的确切天数（3–7 天内）及最终下线 owner 由部署负责人在切换验收后确认。

关联事实源：Helm 私有 Helm 部署仓库 commit
`c3156272c7aaa09d8896e7f2b71046a6d68d95e1` 中的
`docs/superpowers/specs/2026-11-17-agent-infra-helm-native-lane-design.md`（blob
`542c4389ee6a2b35093d58707422b52ca0b7c522`，SHA-256
`b93af1da087d977436ec0a7add30742b17e6dcf2a8d4658e2115c0d1ee5ed174`）；本仓工程边界见
[工程 Spec §4.1.1](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#411-正式-helm-native-部署单元)和
[§21.2.1](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#2121-正式-lane-发布流程)。
