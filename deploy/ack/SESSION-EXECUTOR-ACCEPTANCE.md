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

确认排空时，`read` 读取原 Pod 的 executor 和 `runtime` 容器日志，前后核实 Pod UID。
只读身份须有原 Pod 的 `get` 和 `pods/log` 权限。executor 在发出终止前记录已认证 Stop 的
epoch、fence、库存摘要和实际登记组。Host 验签并持久化证明后记录逐组退出与验证时间。
Driver 持久提交终态后，Host 记录原终态事件的时间。读取器将三份证据按原 Stop、Execution、
Pod、generation/resource fence 和库存关联，核对登记组、截止时间和持久终态时序。
同一 Stop 未排空时可以沿更高 stop fence 续期。读取器保留旧尝试，以原 runner 最新封闭的最高
fence、epoch 和库存摘要匹配证明及持久终态。旧 seal 必须保持同一 epoch 和登记组，不能用旧
fence 的证明签收续期后的 Stop。同一最高 fence 记录冲突、原记录缺失或证明晚于持久终态
时返回待核实。检查同一最高 fence 的全部候选证明后才选择匹配摘要，不能先按 digest
过滤而丢弃冲突；混合有效证明与 epoch、摘要或登记组不一致的证明同样保持待核实。

原生 `process/start` 明确拒绝时，Host 仍保留原 attempt，并在原 journal 持久记录经过
认证的拒绝摘要与时间。seal 和证明的可选 `rejectedStarts` 逐项给出 `id`、`rejectedAt`；
它们与实际 `groupIds`、`groups` 分开，不表示存在过进程组。读取器要求两端的拒绝记录
一致、时间不晚于证明，并沿原 epoch、Stop fence 和库存摘要关联。runner 还须核实原
executor 的完整后代范围已经退出。没有明确原生应答、传输中断或结果未知时不得生成
此记录，仍保留占用。只有拒绝记录而没有实际组的场景可确认“没有遗留进程”，不能
代替 AC-1 对真实工具进程取消的验收。

采用实例身份 V2 时，seal、证明及持久终态另带严格的 `startup` 范围，固定
`schemaVersion: 2`、原 `attemptId`、`startupRef`、Store `recordRef` 和 `factDigest`。
读取器独立对照计划回执的原启动引用，三份证据须属于同一实例；同 epoch/fence 下不同
attempt、启动引用或已提交事实不能互相签收。缺证或混合范围冲突仍返回待核实，
不推进旧 journal 或 ACK 游标。旧格式证据沿原读取规则处理，不据此授予新实例权限。

实例 V2 的生产者只接受部署配置 `workload.policy.executorInstanceStartupApprovals` 中
与实际不可变镜像匹配的记录。每条含 `schemaVersion: 2`、完整 `imageDigest` 和
已评审契约验证的 `verificationRef`。缺失记录不准入 V2，不以 Pod 健康推断支持。
沿用现有启动开关及全部 Pod 字段名；本文件不授权启用，#4274 门禁仍适用。

回退操作遵循 [HLD 的混合版本与回退规则](../../docs/architecture/HLD-agent-runtime-M1.md#1031-排空通道的实例身份交付)。
部署负责人先以兼容版本将上述 approvals 置为空列表，冻结新 V2 启动和新业务提交，
保留原布局、启动开关、身份消费者及原 Stop/事件通道。确认旧 Worker 实例退出后，
沿正式入口结清或退休原范围。再使用已批准的只读数据库 URL 文件执行预检；URL 不进参数或 env。

```bash
node packages/platform-store/src/executor-instance-rollback-preflight.mjs \
  --database-url-file <只读连接文件> --namespace <namespace> --consumer-protocol 1
```

文件须为当前运维用户持有的普通文件，无组或其他用户权限、硬链接和符号链接。
命令在只读事务中，先与实例生产事务排序，再读取完整采用清单及未结束的 Sandbox lease，
只输出汇总数量与兼容布尔值。待确认交付、未退休 V2 实例、活跃 lease 或证据不完整均拒绝旧消费者。
拒绝时保持兼容版本与原事实；预检通过也不代替发布权限和目标配置回读。
