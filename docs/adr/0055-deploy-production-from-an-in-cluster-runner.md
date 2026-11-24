# 由集群内 runner 执行生产部署，标准镜像从内部 Registry 拉取

状态：工作流 Spec §10.3 与 §10.4 随本变更评审；实现见 [#4502](https://github.com/AgoraIO-Extensions/agent-infra/issues/4502) 的子 Issue。

生产 lane 的 Helm 部署本身只需约 1 分钟，但每次升级都由 Agent 会话手工串联预热、部署、验证和验收，
并手写交接，会话停顿会让一次升级拖到数小时。标准镜像从 GHCR 冷拉也慢且不稳定：2026-11-24 在生产
ACK 的 ECI 上冷拉同一 platform-api 子 manifest，GHCR 两次分别为 51.8 秒和 9 分 58 秒，内部 Registry
两次分别为 25.3 秒和 28.8 秒。

选择把部署交给本仓库的部署 workflow，在 ACK 集群内的临时 self-hosted runner 上执行 Helm 部署仓库的
既有入口；生产凭据只以集群内 Secret 交给执行器。合入部署仓库 `main` 即批准日常部署，含迁移、回滚
和有活跃用户 Session 的滚动仍需部署负责人批准。标准镜像在发布后按原 digest 同步到内部 Registry，
生产从内部 Registry 拉取，缺镜像时部署失败而不回退 GHCR。完整规则只在
[工作流 Spec §10.3](../architecture/SPEC-ai-native-development-workflow.md#103-生产部署执行器) 和
[§10.4](../architecture/SPEC-ai-native-development-workflow.md#104-标准镜像同步) 维护。

## Considered Options

- **GitHub 托管 runner 直连 ACK**：所有生产 Secret 都要进入 GitHub，托管 runner 也无法可靠访问 Helm 部署仓库。
- **把部署 lane 迁到 GitHub 私有仓库**：仍要把生产 Secret 交给 GitHub，还要迁移部署仓库既有的
  Secret 约定和其他服务的部署方式。
- **在部署仓库所在平台另建流水线**：与本仓库的 Issue、PR 和 Actions 门禁分离，Agent 无法用同一套
  工具触发和回读。

## Consequences

本仓库是公开仓库，self-hosted runner 只能由受保护 `main` 上的部署 workflow 调度，不能与 CI 机池共用。
GitHub 侧新增一个只能写入单个 project 的 Registry 推送凭据。第一期执行器沿用现有 kubeconfig，收窄为
专用 ServiceAccount 另行跟踪。
