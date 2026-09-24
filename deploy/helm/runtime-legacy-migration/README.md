# Runtime 历史主体迁移 Job

本 chart 独立调用正式 Host 镜像中的 `legacy-migration-cli.mjs`，不安装 Platform 组件，
不作为主 chart 的升级 hook。历史来源与完整签名绑定遵循
[Runtime HLD](../../../docs/architecture/HLD-agent-runtime-M1.md#81-消息与命令幂等)。
CLI 输入和提交语义见 [Runtime 部署说明](../../runtime/README.md#就绪证明与历史-session-迁移)。

运行前由部署方完成以下准备：

1. 核实原 producer 证据及 Platform 已提交的迁移审计，用独立部署信任根签名。
   映射与公钥分别存入目标 namespace 的现有 Secret；签名私钥不提供给 Job。
2. 通过正常生命周期停止 Agent，清退所有使用原 PVC 的 Pod，阻止其他消费者重新挂载。
   `offline-commit` 还要求该隔离部署的全部 Platform API/Worker 入口持续停机，
   直到 Job 退出且移除。chart 不负责停机；本地锁、布尔配置和数据库行锁不能替代维护窗口。
3. 准备原数据 PVC 和独立候选 PVC，所挂载目录须由 UID 1000 可写，候选目录不得允许
   group/other 写入。推荐两个目录均为 `1000:1000`、`0700`；原 `host.json` 必须已存在。
   chart 不创建 PVC，不递归 chown 数据，不设置 fsGroup。candidate 模式也需要原 PVC 可写，
   因为 CLI 会创建短期排他锁；原 journal 字节保持不变。
4. 从可信部署记录填写 `binding`，包括原 Workload 的 workerId、agentId、revision、fence
   和 imageDigest。`image.digest` 另行指定本次执行迁移 CLI 的正式镜像，不能用它替代原
   Workload 的绑定。`issuer`、`trust.keyId` 必须与签名映射相符。

使用私有 values 文件提供这些输入，先渲染并检查：

```bash
helm template runtime-migration deploy/helm/runtime-legacy-migration \
  --namespace "$NAMESPACE" --values "$VALUES_FILE" > "$MANIFEST_FILE"
```

确认维护窗口后才把渲染结果应用到同一 namespace。默认 `mode: candidate` 只验证并生成
候选；只有显式 `mode: offline-commit` 才能原子提交。Job 无自动重试、无 ServiceAccount
token，无模型、数据库或服务凭证；NetworkPolicy 禁止其出入站。集群须实际执行该策略，
且不得有其他选择该 Pod 的允许规则；NetworkPolicy 的允许范围会叠加。
两个信任文件以 root 所有的 `0444` 普通文件 subPath 挂到固定目录，CLI 实际复验所有权、
目录链、签名和完整原执行集合，任一不符即拒绝。

Job 日志只输出状态、绑定和摘要。候选原文保存在候选 PVC 的 `candidate.json`，按原任务
数据权限保管，不能贴入日志或 PR。通过受控维护挂载检查候选及原 journal 摘要后，先移除
该挂载再安排下一次运行。已有候选文件会拒绝覆盖；重试使用新的候选 PVC，不能盲目重复。
卸载 chart 不删除现有 PVC 或 Secret。保留结果和摘要，确认 Job 及相关 Pod 已退出并移除后，
再按正常生命周期恢复入口；迁移映射本身不授予业务、控制或 Connection 权限。
