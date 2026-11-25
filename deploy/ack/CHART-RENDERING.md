# ACK 通用 chart 渲染核对

`deploy/ack/chart` 包含可复用的工作负载、配置 Secret、目录源、证书、ImageCache 和 Hook 模板。
主机名、内部服务地址、凭据、镜像 Digest、批准记录及专用开关的取值由私有 Helm 仓库的环境配置提供。
配置文件和渲染结果可能包含 Secret，不得提交到公共仓库，也不能直接输出到 CI 日志。

## 默认配置与回归测试

```bash
node --test tests/ack-*.test.ts
```

默认关闭 chart 自建 Secret、配置模块、目录源、证书和 ImageCache；原有外部 Secret 引用继续有效。
生产形状 fixture 使用保留域名和合成数据，覆盖这些资源及 Connection 安装的正反向门禁。
它不替代真实生产 release 的等价核对。

`worker.executorInstanceStartupApprovedImages` 由环境提供精确 Digest 清单；每条启动批准仍需
`verificationRef`，清单之外的批准不能渲染。默认空清单不会批准任何镜像。
`worker.piSessionPlacement` 与 `worker.nativeMetadataGateway.agentCallbacks` 默认保留公共 chart
已有的 Pi 放置声明与 Agent 回调策略；旧 Worker 环境须显式记录兼容取值，不能据此宣称运行时已升级。
迁移 Job 可显式提供 deadline 与通用 resources，未提供 resources 时使用对应组件的资源声明。

## 生产 release 等价核对

在 clean checkout 中，使用固定的私有环境版本、release revision、Kubernetes 版本和具名 kubeconfig。
先按私有仓库规则生成 values，再只读获取该 release 的普通 manifest、Hook 和 metadata。
使用同一 release 名称及 namespace 渲染公共 chart，核对前后 metadata 的 revision 未发生变化。

```bash
umask 077
helm get manifest "$RELEASE" -n "$NAMESPACE" --kubeconfig "$KUBECONFIG_FILE" > "$BASELINE_MANIFEST"
helm get hooks "$RELEASE" -n "$NAMESPACE" --kubeconfig "$KUBECONFIG_FILE" > "$BASELINE_HOOKS"
helm template "$RELEASE" deploy/ack/chart -n "$NAMESPACE" --kube-version "$KUBE_VERSION" \
  -f "$PRIVATE_ENV_VALUES" -f "$PRIVATE_CHART_OVERRIDES" -f "$PRIVATE_GENERATED_VALUES" > "$CANDIDATE_MANIFEST"
```

将 baseline manifest 与 Hook 以 YAML 文档分隔符合并到受控文件后执行：

```bash
node deploy/ack/compare-chart.ts "$BASELINE_WITH_HOOKS" "$CANDIDATE_MANIFEST"
```

比较器忽略 YAML 键顺序和资源文档顺序，保留数组顺序，比较全部字段，包括 Secret data、
Hook 和注解；重复资源或无效 YAML 会失败。输出只包含资源计数及发生差异的资源标识。
差异须为零，或逐项记录并取得确认。私有证据保留源码版本、release revision、输入与输出摘要及比较结果。
整个流程不执行 upgrade、apply 或部署入口切换。

## 仓库外的部署输入

域名路由 Owner 输入验证器使用独立评审的 target 文件，不从待验证 bundle 推导允许的目标：

```bash
node deploy/ack/domain-route-owner-input.ts "$OWNER_BUNDLE" "$SOURCE_SHA" "$EXPECTED_CAS" "$REVIEWED_TARGET"
```

target 包含 `agentId`、HTTPS `origin`、不同的 `platformOrigin` 与 `tlsSecretName`。
验证器继续核对精确 hostname/SAN、Agent/path、source SHA、CAS、证书交付与元数据引用。
JSON Schema 只校验文档形状；部署前必须执行语义验证器。

个人 Relay Key 的 billing URL 由可信部署配置提供；仅接受 HTTPS 的固定 `/v1/sub2api/billing`
路径，禁止 userinfo、query、fragment 和重定向。Owner 请求不能提供该地址。
Connection GitHub E2E 使用受保护的 `connection-e2e` GitHub Environment 变量
`CONNECTION_E2E_ENDPOINT` 指定 HTTPS `/mcp` 地址；启用工作流前须由环境负责人配置。
