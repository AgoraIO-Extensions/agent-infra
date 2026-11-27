# 由集群内 runner 执行生产部署，标准镜像从内部 Registry 拉取

状态：工作流 Spec §10.3 与 §10.4 随本变更评审；实现见 [#4502](https://github.com/AgoraIO-Extensions/agent-infra/issues/4502) 的子 Issue。

生产 lane 的 Helm 部署本身只需约 1 分钟，但每次升级都由 Agent 会话手工串联预热、部署、验证和验收，
并手写交接，会话停顿会让一次升级拖到数小时。标准镜像从 GHCR 冷拉也慢且不稳定：2026-11-24 在生产
ACK 的 ECI 上冷拉同一 platform-api 子 manifest，GHCR 两次分别为 51.8 秒和 9 分 58 秒，内部 Registry
两次分别为 25.3 秒和 28.8 秒。

选择把部署交给本仓库的部署 workflow，在 ACK 集群内的临时 self-hosted runner 上执行 Helm 部署仓库的
既有入口；生产凭据只以集群内 Secret 交给执行器。合入部署仓库 `main` 即批准日常部署，含迁移、回滚
和有活跃用户 Session 的滚动仍需部署负责人批准。标准镜像在发布后按原 digest 同步到内部 Registry，
生产从内部 Registry 拉取，缺镜像时部署失败而不回退 GHCR。日常业务验收使用已授权的 Task API 主体，
复用双人 OIDC 登录证据，使每次发布都能验证当前版本的四个模板。完整规则只在
[工作流 Spec §10.3](../architecture/SPEC-ai-native-development-workflow.md#103-生产部署执行器) 和
[§10.4](../architecture/SPEC-ai-native-development-workflow.md#104-标准镜像同步) 维护。

## Considered Options

- **GitHub 托管 runner 直连 ACK**：所有生产 Secret 都要进入 GitHub，托管 runner 也无法可靠访问 Helm 部署仓库。
- **把部署 lane 迁到 GitHub 私有仓库**：仍要把生产 Secret 交给 GitHub，还要迁移部署仓库既有的
  Secret 约定和其他服务的部署方式。
- **在部署仓库所在平台另建流水线**：与本仓库的 Issue、PR 和 Actions 门禁分离，Agent 无法用同一套
  工具触发和回读。

## Consequences

本仓库是公开仓库。组织套餐不能建立自定义 runner group，集群内 runner 以仓库级 runner 注册，本仓库任何
workflow 都可能被调度到它；隔离改为依赖凭据：runner Pod 不挂任何凭据，部署 job 以 GitHub OIDC 身份访问
API Server，RBAC 只授权 `main` 上 `production` Environment 的 job。第一期该身份与它替代的运维 kubeconfig
同为 cluster-admin，收窄为专用 ServiceAccount 另行跟踪。Kubernetes NetworkPolicy 不能按域名放行，而部署仓库、
GitHub、Registry 与工具下载源都在公网，所以 runner 放行公网、拒绝私有网段与云元数据服务。公开仓库的 Actions
日志也公开，部署入口的原始输出只保存在集群内。

GitHub 侧新增一个只能写入单个 project 的 Registry 推送凭据。镜像同步最初放在 GitHub 托管 runner 上，
实测无法在可用时间内推送到内部 Registry，后改为同一集群内另一组专用 runner，原因见 §10.4。

## 按 tag 部署与 chart 分工

本仓库 main 提供可信执行器与通用 chart；Helm 部署仓库 main 只提供环境配置、私有渲染入口与
密钥。版本从成功的 `Publish images` 正式 tag 回执解析，渲染引用的全部 digest 必须通过内部 Registry
检查；不再使用 `lane.json` 固定 App source 或镜像。空版本保留已部署 release 的版本与镜像，
只更新环境配置。实现与约束见[工作流 Spec §10.3](../architecture/SPEC-ai-native-development-workflow.md#103-生产部署执行器)。
