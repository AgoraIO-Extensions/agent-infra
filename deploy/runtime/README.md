# Codex Pilot 运行装配

本入口消费部署已批准的 Agent active 配置，遵循
[Runtime HLD §3.1](../../docs/architecture/HLD-agent-runtime-M1.md#31-标准-runtime)
与[工程 Spec §10.7](../../docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md#107-标准模板模型配置)。
它不读取 Platform DB、ModelCatalog、Connection credential 或部署解密 keyring。

## 固定镜像

`apps/agent-runtime-host/Dockerfile` 在构建时安装 Codex `0.153.0`，支持
`linux/amd64` 与 `linux/arm64`。固定资产、SHA-256 与 LICENSE/NOTICE 的来源记录在
[`codex-release.json`](../../packages/agent-runtime/src/codex-release.json)。安装程序验证压缩包、
解压后的可执行文件和法律文件，最终镜像保留 `/opt/codex/share/` 中的来源与法律信息。
正式入口在启动原生进程前复验文件，Bridge 再验证版本与协议 Schema。启动不下载依赖。

## 部署输入

以下 `AGENT_INFRA_*` 输入只能由受信部署装配。Owner 与 HTTP 请求不能选择 Driver、原生路径、
endpoint 或 credential。`AGENT_INFRA_RUNTIME_DRIVER=codex` 是固定模板绑定；`fake` 仅用于独立测试。

| 环境变量 | 内容 |
| --- | --- |
| `AGENT_INFRA_RUNTIME_AGENT_ID` | 当前 Agent ID；Grant 必须绑定该 Agent |
| `AGENT_INFRA_RUNTIME_DATA_DIR` | 当前 Agent PVC 的绝对挂载路径，镜像默认为 `/var/lib/agent-runtime` |
| `AGENT_INFRA_RUNTIME_MODEL_CONFIG` | 下述 schemaVersion 2 的 active 模型配置 JSON |
| `AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_*` | 每个 active 选项的运行凭证，由配置中的保留环境变量名精确引用 |
| `AGENT_INFRA_RUNTIME_SERVICE_TOKEN` | Worker 到 RuntimeHost 的服务认证凭证 |
| `AGENT_INFRA_RUNTIME_GRANT_KEY_ID` | 已批准的 Grant 签名公钥标识 |
| `AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY` | Ed25519 PEM 公钥 |
| `AGENT_INFRA_RUNTIME_GRANT_ISSUER` | 预期 Grant issuer |
| `PORT` | HTTP 监听端口，默认为 `3003` |

模型配置结构示例，不包含凭证：

```json
{
  "schemaVersion": 2,
  "configVersion": "active-revision-1",
  "defaultModelOptionId": "codex-default",
  "defaultReasoningLevel": "medium",
  "modelOptions": [
    {
      "modelOptionId": "codex-default",
      "endpoint": "https://approved-model.example/v1",
      "model": "gpt-5.2",
      "reasoningLevels": ["medium", "high"],
      "credentialEnvironmentVariable": "AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_CODEX_DEFAULT"
    }
  ]
}
```

模型选项、凭证传递、原生路由与失败处理遵循
[工程 Spec §10.8](../../docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md#108-codex-原生模型传输边界)。

`host.json` 与 `codex-driver.json` 位于该 Agent 数据目录；Driver 使用 #403 的
`codex-driver.json.native` 持久目录装配。关闭进程不删除这些业务数据，损坏或丢失状态仍按
[HLD §7.3](../../docs/architecture/HLD-agent-runtime-M1.md#73-重启恢复) 拒绝替代恢复。

## 镜像验证

```bash
pnpm docker:build
node deploy/release/runtime-probe.mjs agent-infra-agent-runtime-host:latest /tmp/codex-runtime-probe.json
```

probe 以镜像内容 ID 启动 non-root 容器，根文件系统只读且外部网络关闭，在容器内通过正式环境
入口、HTTP/SSE 和真实 pinned Codex 访问合成模型替身。验证默认与 Execution 模型选择、授权、
幂等、重启读取、401/403/503、redirect、错误 content type、流内失败、异常流、取消与递归落盘
脱敏。另一次运行覆盖可执行文件校验失败。probe 不保存模型请求正文、Native ID、原生协议帧
或凭证。

CI 保存 `codex-runtime-probe-<commit>` artifact，其中 `imageId` 保存 Docker 回读的镜像内容标识，
运行环境提供 OCI manifest/index Digest 时保存为 `imageDigest`；不将 Docker 镜像 ID 当作 OCI config Digest。
probe 只接受 clean checkout；存在未提交修改时直接失败，不写入可被误用的通过证据。成功证据中的
`sourceDirty` 固定为 `false`。
现有 `build-images.mjs` 在任何发布前执行同一 probe，并在 image manifest 旁保存
`.runtime-probe.json`，绑定该 clean commit、已核验镜像 Digest 与 Codex/config 版本。
扫描结果仍由 #405 的统一入口提供，使用同一 commit 与镜像内容标识关联。
该入口落地后 CI 的镜像构建步骤直接使用扫描器的 `build` 命令，并以本次生成的
`--scan-build .vulnerability-scan/build.json` 执行 probe，要求其 `source.commit`
匹配当前 commit，并直接运行 `agent-runtime-host` 记录的 `imageId`。对应
`imageId` 必须相同；缺失或不匹配的构建记录不能回退到 Compose Tag。

本验证不代表 #404 多人隔离验收、#194 完整 Pilot 或生产上线，也不执行镜像发布与共享环境部署。
