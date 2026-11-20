# ACK 独立 executor 排空验收

场景和通过判据见 [Runtime HLD §10.3.1](../../docs/architecture/HLD-agent-runtime-M1.md#1031-排空通道的实例身份交付)。
部署负责人为批准的窗口准备独占验收 namespace、两个合成 Sandbox 和候选镜像。
准备阶段应固定场景夹具和原始取证路径。业务 Stop 使用原产品 API。

`executor-plan-*` 是不可变 ConfigMap。其 `data.plan.json` 固定 `schemaVersion: 1`、
候选镜像的 `imageDigest`、窗口 `startsAt` 和 `expiresAt`（Unix 毫秒），以及两个
`targets`。每个目标有 `sandbox`、`generation` 和 `resourceFence`。
`fixtures` 为批准的场景与目标对，每条固定 `scenario`、`sandbox` 和夹具
`fixture.json` 原始字节的 `sha256:<hex>` 摘要。

场景夹具由部署负责人准备。夹具 ConfigMap 名为 `executor-fixture-<ref>`，其中
`ref` 是 `JSON.stringify([planUid, sandbox, scenario])` 的 SHA-256 前 24 个小写十六进制字符。
夹具对象不可变，owner reference 指向计划的 UID。其 `data.fixture.json` 固定
`schemaVersion: 1`、`scenario`、`sandbox`、原 `podUid` 和批准的 Kubernetes Job
`jobSpec`。Job 的时间窗口覆盖本次场景，使用该候选镜像，`backoffLimit` 设 0。

A 通过获准的只读 kubeconfig 执行以下命令。参数为验收 namespace 与计划名。

```bash
node deploy/ack/session-executor-acceptance.mjs list --plan <namespace>/<plan>
node deploy/ack/session-executor-acceptance.mjs read --plan <namespace>/<plan> --run <run>
```

只有部署负责人使用写入 kubeconfig 发起批准的场景。命令复核原 Pod UID、隔离范围、
generation、fence 和镜像后，创建同名唯一 Job。结果不明时先回读原运行引用。

```bash
node deploy/ack/session-executor-acceptance.mjs run --plan <namespace>/<plan> \
  --scenario <scenario> --target <sandbox>
```

场景夹具从原启动或原 Stop 的受信来源收集摘要后，部署负责人用
`executor-run-<ref>` 的不可变 ConfigMap 交付 `data.receipt.json`。回执须带计划的原 UID、
窗口、目标元组及固定状态。字段由只读入口校验。A 的授权限制在批准的计划和回执
ConfigMap 名称。若缺少回执或原业务 Execution，分别按照 HLD 判为待核实或不适用。

已确认排空的回执还填写 `stop.firstTerminalAt`。此值是原业务只读查询首次观察到终态的时间。
`read` 经获准的 Kubernetes 只读身份读取原 Pod 的 `runtime` 容器日志，在读取前后核实 Pod UID。
须有该 Pod 的 `get` 和 `pods/log` 读取权限。命令仅投影 `CODEX_EXECUTOR_DRAIN_VERIFIED`。
Host 在验签并持久化原 runner 的排空证明后写入该记录，包含原 executor epoch、Stop fence、登记组摘要、
逐组退出时间和 Host 验证时间。原 Pod 无法核实、记录缺失或退出、验证和首次终态时间不符时返回待核实。
