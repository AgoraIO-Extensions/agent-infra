---
name: agent-builder
description: 通过用户授权的 Connection 把 Compose 或代码仓库转换为受限的 Agent Dockerfile 与纯 Kubernetes YAML，并经隔离分支、Pull Request、不可变镜像 Digest 和平台 API 创建或升级自定义 Agent。
---

# agent-builder

## 先确认边界

这个 Skill 运行在标准模板 Agent 上。源码、分支、Pull Request、CI 和平台调用都属于用户授权的 Connection；Skill 不接受用户粘贴的 Token、密码、OAuth code、私钥或完整会话正文，也不替平台保存源码、构建状态或镜像。

Skill 只消费现有 CI 或用户构建流程产生的不可变 `sha256:<64 个小写十六进制字符>` 镜像引用。Skill 不替用户构建镜像、不推送镜像、不创建 Helm release，也不直接提交 Compose 到平台。

## 工作流

1. 通过 Connection 解析当前用户、目标仓库、默认分支和可用 CI 能力。若身份、仓库或授权无法确认，停止并说明缺失项。
2. 在最新默认分支上创建隔离分支和临时工作区。读取仓库的 `docker-compose.yml`；没有 Compose 时只读取用户授权的代码范围并说明推断依据。
3. 先做输入门禁。遇到 `privileged`、`network_mode: host`、`devices`、bind mount、主机路径、Helm chart、动态下载依赖或无法固定的外部镜像时，停止生成部署结果并逐项解释原因。不要把不支持的输入静默改写成可部署配置。
4. 生成 Dockerfile 和纯 Kubernetes YAML。YAML 必须通过仓库的 multi-service manifest 契约校验：只使用契约允许的 Deployment、StatefulSet、Service、ConfigMap、PersistentVolumeClaim 和受控迁移 Job；服务使用 ClusterIP，入口 Service 只有一个；容器镜像全部使用 immutable digest；不写 Secret、Ingress、NetworkPolicy、ServiceAccount 或 Helm 模板。
5. 对每个服务给出资源 profile 引用；保留 StatefulSet 的 PVC 声明和数据路径。需要迁移时生成单个受控 Job，并在说明中写明它必须成功后才可切换。
6. 在隔离分支提交 Dockerfile、YAML 和必要的非敏感说明，执行格式检查与契约校验，然后通过 Connection 创建 Pull Request。不得写受保护分支；没有 Pull Request 就不能宣称交付完成。
7. 等待仓库 CI 或用户构建流程返回镜像 Digest。只接受 Connection 回读的真实 Digest 和对应 CI 证据；缺少 Digest 时保持等待，不猜测 tag、image ID 或 registry 地址。
8. Digest 到达后，通过 Connection 的 agent-infra 平台 API Provider 创建或升级 Agent。请求只提交 Agent、YAML、Digest 和用户已授权的非敏感配置；当前身份、组织、Connection 和权限由服务端解析。
9. 查询平台状态直到成功、受控失败或明确不可用。失败时按 API 返回的错误码和脱敏说明修正输入或如实拒绝；不要读取日志正文来拼接新的凭证或绕过准入。

## 离线演练

没有 Connection、CI 或平台 Provider 时，只运行离线演练：用 `references/docker-compose.yml` 作为输入，用 `references/Dockerfile` 和 `references/agent.yaml` 作为预期输出，验证不支持项识别、Dockerfile 存在、YAML 通过 `MultiServiceManifestDocumentV1Schema`，并确认所有镜像都是 digest。离线通过不代表真实仓库、CI、平台 API 或 Agent 已完成。

## 失败和恢复

- Connection 授权、仓库、分支、CI、Digest 或平台 Provider 任一项不可确认时，返回可操作的缺失项；不使用个人配置或环境变量猜测。
- Pull Request 被拒绝、CI 失败或镜像 Digest 变化时，保留原分支和证据，创建新的修订，不覆盖已审阅提交。
- 平台创建或升级返回失败码时，保留版本和 PR 关联，按失败原因迭代；升级失败由平台既有整体回滚策略处理，Skill 不自行删除 PVC 或重放副作用。
- 脚本默认关闭。Skill 只能建议用户明确授权的脚本检查，不能把脚本、Hook、MCP Server、Helm 或任意网络端点变成新的权限主体。
