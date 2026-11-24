# 标准镜像同步

`Mirror images` workflow 把正式发布的标准镜像按原 digest 复制到部署批准的内部 Registry。边界规则见
[工作流 Spec §10.4](../../../docs/architecture/SPEC-ai-native-development-workflow.md#104-标准镜像同步)，
本文只写操作。

## 一次性配置

在仓库 Settings → Environments 新建 `internal-registry-mirror`，Deployment branches 只允许 `main`，
并添加三个 Environment Secret：

| Secret | 内容 |
| --- | --- |
| `MIRROR_REPOSITORY_PREFIX` | 目标仓库前缀，形如 `<registry-host>/<project>/agent-infra`，不带协议和末尾 `/` |
| `MIRROR_REGISTRY_USERNAME` | 只能推送到该 project 的机器账号 |
| `MIRROR_REGISTRY_PASSWORD` | 该账号的密码或 token |

前缀也作为 Secret 保存，使公开日志里只出现掩码。

job 的 `runs-on: agent-infra-mirror` 指向 ACK 集群内由 runner controller 管理的专用 runner 组，
只允许本 workflow 使用，runner 不挂载集群凭据。该组上线前，触发的运行会排队等待 runner。

## 运行方式

- **自动**：本仓库 `main` 上的 `Publish images` 成功后触发。workflow 校验同一 run/attempt 的发布回执，
  复制模板、RuntimeHost、Custom 基础镜像和（存在时）Platform 镜像的 `linux/amd64` 子 manifest。
  smoke 发布记为 skipped。
- **重跑一次发布**：手动运行，填写 `publish_run_id` 与 `publish_attempt`。
- **补同步**：手动运行，只填写 `references`，值为空格或逗号分隔的
  `ghcr.io/agoraio-extensions/agent-infra/<name>@sha256:<digest>`，最多 200 个。用于当前生产与保留模板
  绑定的 digest。

每个镜像写到 `<前缀>/<name>:sha256-<digest>`。复制前已存在且字节一致的记为 present，复制后回读字节并核对
digest，不一致记为失败。重复运行是幂等的。Summary 和 `mirror-receipt-<attempt>` artifact 记录每个镜像的结果和
耗时，不含前缀或凭据。
