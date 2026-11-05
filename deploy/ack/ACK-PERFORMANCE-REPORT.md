# ACK 性能数据与后续方案

本报告按数据与方案收口，不表示秒级首字目标或两次干净重建验收通过。

| Source | 样本数 | 受理 p50 / p95（秒） | 首字 p50 / p95（秒） |
| --- | --- | --- | --- |
| a17531d4 | 4 | 144.401 / 146.578 | 151.895 / 165.348 |
| 0788e7ee | 4 | 2.349 / 3.009 | 15.254 / 20.600 |

0788e7ee 的逐模板样本如下，受理和首字均沿用原浏览器回执的测量口径，不能解释为供应商首 token 耗时：

| 模板 | 受理（秒） | 首字（秒） |
| --- | --- | --- |
| codex | 3.009 | 20.600 |
| claude | 2.634 | 9.922 |
| opencode | 1.620 | 15.768 |
| pi | 2.349 | 15.254 |

每组由四个标准模板各一个样本构成，分位数采用 nearest-rank：N=4 的 p50 是第二个顺序统计量，p95 是最大样本，并非生产尾延迟估计，也不是两个中间样本的算术平均。上述分位数已从汇总文件中的逐模板样本重新计算；两组共 8 份原始浏览器回执的 SHA-256 已逐一匹配；这一校验确认汇总引用的文件完整性，不替代当前 source 的业务验收。

两组 source、reserve 配置、Worker CPU（0.5→2）、测量时段和供应商负载不同，只能作观察对比，不能归因某项优化。首字 15.254 秒属于 0788e7ee 的历史样本，不代表当前待重建 source。

已知缺口：最终 source 的完整运行数据、同一时间域的阶段计时、原生初始化与供应商耗时拆分、reserve 实际命中/隔离/耗尽/清理以及 PVC 预算。标准模板、自定义首次调用和后续调用应分开报告；缺失值不从历史数据回填。

后续方案：固定 source、镜像、资源和模型输入，先补齐受理、Session 准备、Runtime 提交、首文本持久化及完成的同时间域计时；再在同一配置下比较冷/暖路径。预热实验必须同时保留隔离、耗尽回退、退休清理和资源预算验证。当前不继续扩展实现追逐通用首字 ≤3 秒，不新增部署入口。

本报告不替代 #3829 两次从空状态无干预全绿，也不替代 #3779 的 reserve 验收。

汇总证据 SHA-256：`d8ba40b5897e6c7a2b4c81bfddaa60b9c66ec476d218140681c9e4d3fdf1da00`。

## 2026-11-05 首轮优化状态

[#3921](https://github.com/AgoraIO-Extensions/agent-infra/issues/3921) 复核了 3c1f0660 样本（[#3779](https://github.com/AgoraIO-Extensions/agent-infra/issues/3779)：标准首轮受理 2.409 / 3.680 秒，custom 首轮 80.809 / 81.578 秒）对应的候选。以下均未在 ACK 上做同源前后对照，不能当作实测收益。

- Session 启动观测：此前读错了 Runtime 容器名，正常启动被当成停滞，观察间隔按 1 秒×5、2、4、8、16、32、60 秒递增；[#3922](https://github.com/AgoraIO-Extensions/agent-infra/issues/3922) 修复后，60 秒窗口内每秒观察一次。按代码推算，Pod 在第 20、40、50、70 秒就绪时，发现延迟由 15、27、17、57 秒降到 1 秒以内。
- 首轮分段：[#3923](https://github.com/AgoraIO-Extensions/agent-infra/issues/3923) 让浏览器回执在同一页面时钟下拆出创建、等待 Session 和受理三段，并读取已持久的模型耗时。服务端用已有的阶段指标（`drain.prepare`、`drain.route`、`sandbox.reconcile.prepare` 等）和 `conversation.sandbox.observed` 审计时间，暂不新增 Runtime 事实。
- custom 预留实例：不扩展，理由见 [ADR-0038](../../docs/adr/0038-no-owner-secret-in-session-reserves.md)。custom 冷路径的镜像缓存由 [#3931](https://github.com/AgoraIO-Extensions/agent-infra/issues/3931) 负责，严格模式尚未开启。
- 同 Session 原生复用和 Runtime 提交前的多次路由复核，在 ACK 对照给出阶段占比之前不改。

剩余缺口仍是同源 ACK 对照（#3921 AC-3），需要 ACK owner 提供执行窗口。
