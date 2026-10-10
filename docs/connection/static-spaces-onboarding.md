# StaticSpaces onboarding 验证

本文记录 [#1672](https://github.com/AgoraIO-Extensions/agent-infra/issues/1672) 的可复核证据，不改变
[HLD 3.2.2](../architecture/HLD-connection-M1.md#322-staticspaces-deployment-与-action-边界) 和
[HLD 13.4](../architecture/HLD-connection-M1.md#134-provider-onboarding) 的发布门禁。

## 当前结论

2026-10-10，七项 Action 的真实账号 guarded Adapter canary 成功；该结果不是 Connection HTTP/MCP
E2E，也未达到测试计划的发布验收标准。生产目录仍不发布 StaticSpaces，
`staticSpacesVerificationMatrix` 仍为 `UNVERIFIED`。
结构化结果见 [验证记录](static-spaces-onboarding-evidence.json)。
生产依赖许可证清单见 [CycloneDX 清单](static-spaces-production-dependencies.cdx.json)，由当前
lockfile 对应安装树的 `pnpm licenses list --prod --json` 生成，排除了本机路径。它是源码依赖
清单，不是最终容器 SBOM，也不能代替 Legal/Security 签收或镜像签名。

测试固定到外部账号 `841`、shared space `connection-test`、既有 owner/viewer group UUID 和
Application UUID。最终脚本在调用前验证账号、组 ID 和只读 Application identity；发布回执再次核对
Application 和组 ID。测试不添加成员、
不改变 ACL、不写业务空间。所有本轮文件带随机 run ID；清理前逐个回读并核对 SHA-256，清理后
回读文件列表确认本轮没有遗留；单个文件清理失败不阻止其他文件清理，并保存失败证据。
最终脚本要求内容包含 `connection-e2e:<runId>` marker。测试空间和此前测试文档保留。

最终脚本使用官方 `GET /api/v3/core/applications/?slug=<exact-slug>` 列表接口，只接受唯一的
精确 slug 匹配，并核对 Application UUID 与 launch URL；其真实 preflight 返回 200。
此前单对象 identity 查询返回 403 的运行于任何 WRITE 前失败，记录零调用、零本轮资源。
两份记录均保留，未扩大账号权限。

## 证据与缺口

| HLD 13.4 项 | 已验证 | 尚需完成 |
| --- | --- | --- |
| Token acceptance | 固定 Authentik origin 的 Bearer API Token；invalid Token 被拒绝 | 正式 Credential 表单提交 |
| Stable identity | 活跃、非 superuser；stable `pk=841`；个人目标禁止调用方 username | Connection ownership 和 Grant 实际链路 |
| Credential lifecycle | 独立临时 Token 创建 201、身份 200、撤销 204、撤销后身份 403；当前 Token 重新验证 200 | 实际到期、Connection reauth/disconnect/revoke |
| Egress | 与 runtime 相同的 DNS pinning、固定 origin、TLS 校验、禁止 redirect 的真实 transport；写入前核对空间 immutable identity | 生产 Pod 完整受控链路 |
| 限流与幂等 | 上游没有原生幂等合同；response-lost 仅提交一次，保留 submission uncertainty | 部署边缘限流、request ID 合同的 Owner 确认 |
| Schema | 七项真实输出通过当前 Adapter Schema；下载 bytes、HTML 和归档回执 hash 校验通过 | Connection Call/Effect 的完整投影 |
| READ/WRITE | 七项 guarded Adapter canary；权限拒绝 403、禁止覆盖 409；本轮四个文件清理成功 | 正式 Connection/MCP canary |
| 供应链与评审 | executor digest 固定；无新依赖或上游源码复制；已生成生产依赖许可证清单 | 正式 Legal/Security 签收和签名发布证据 |

普通用户 Token 创建/更新接口把有效期固定为 7 天；提交自定义到期时间不会生效。本次没有等待
7 天，也没有把该行为伪装成“到期验证通过”。当前 Token 保留，撤销测试只针对独立临时 Token。
Connection 不实现 OAuth refresh，不在失效后自动换号或换凭证。

response-lost canary 在真实上游完成上传后丢弃响应；Adapter 返回 `submissionUncertain=true`，
实际提交次数为 1，随后只读核对字节并清理。它证明真实效果和 Adapter 不重试；不证明持久
Call/Effect 已进入 `UNCERTAIN`，该项必须由 Connection 完整 E2E 补齐。

## 受监督运行

该脚本不自动进入 CI，不发布 Catalog，不创建 Grant，不保存 Token 到证据文件。两个 Token
从本机受限文件读取；第二个必须是已撤销的独立临时 Token，不能撤销当前使用中的 Token。
删除仅为测试操作者清理本轮已验证文件，不向 Connection 新增删除 Action。

```bash
CONNECTION_STATIC_SPACES_E2E_ENABLED=true \
CONNECTION_STATIC_SPACES_TOKEN_FILE=/path/to/current-token \
CONNECTION_STATIC_SPACES_REVOKED_TOKEN_FILE=/path/to/revoked-test-token \
CONNECTION_STATIC_SPACES_TEST_SLUG=connection-test \
CONNECTION_STATIC_SPACES_EVIDENCE_FILE=/path/to/redacted-evidence.json \
node tests/static-spaces-onboarding.mjs
```

## 发布阻塞

[OpenConnector ADR](../adr/ADR-connection-openconnector-kernel-boundary.md#状态) 仍明确写着
“Legal 与 Security 发布门禁仍未关闭”。当前 GHCR workflow 没有显式的签收或签名验收步骤。
已有镜像或其他 Provider 可用不构成本次批准。正式批准记录、部署限流合同和供应链证据未核验前，
不得把本记录输入生产验证矩阵、手动注册生产 Catalog 或用环境开关开放 Provider。

普通用户调用 Authentik `GET /api/v3/core/applications/<slug>/` 返回 403；带 `for_user=841`
的列表请求返回 400 `User not found`，但精确 slug 列表请求返回 200 并提供匹配的 immutable
identity。脚本使用最后一种查询；不能使用管理员 Token、伪造 identity header 或把写入后的回执
当成写入前证明。

门禁证据齐备后，另行更新生产验证矩阵并发布；从 Connection 页面提交当前 Token，完成前置
连接审批和 Consent/Grant，再用 MCP 验证读取及同一测试容器内的写入。该次运行必须记录
`callId`、Effect 终态、入站 idempotency key 与结果核验，并确认 Consumer 不能读取 Credential。
