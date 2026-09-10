# Codex 模型错误在原生持久化前脱敏

[#406](https://github.com/AgoraIO-Extensions/agent-infra/issues/406) 的合成失败探针表明，供应商错误
可能在 Host 投影脱敏前被原生 Codex 写入持久历史。采用 Codex Driver 内部的 loopback 模型传输
边界，在错误到达原生进程前脱敏，并把上游 credential 留在父进程；具体约束由
[工程 Spec §10.8](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#108-codex-原生模型传输边界)定义。

仅脱敏 Host 返回值不能保护原生落盘，删除持久历史会破坏恢复语义。保留历史并在原生协议入口
处理失败，会增加流解析、取消和生命周期验证成本，因此必须以真实 pinned Codex 和实际镜像
验证；该传输边界不能替代多用户隔离，也不成为通用模型路由或独立部署服务。

决定依据为 #406 记录的委托方案决策；独立评审、实现和验收仍按该票的当前版本证据完成。

每个 Owner 模型选项可有独立 endpoint 和 credential，不能把 active 配置压缩为一组共享值。
固定 Codex 的 Turn 接口没有 provider override，实测对已加载 Thread 调用 resume 也不会切换
provider；采用选项唯一的 namespaced model，在父进程精确映射并改回真实 model。该版本原生
metadata lookup 支持剥离单个 namespace 后匹配模型，因此无需生成自定义能力目录。映射是
批准配置的确定性翻译，不增加供应商发现或故障切换。配置生产者由 #436 交付，#406 验证消费。

实际 pinned Codex 取消探针表明，Turn 已中断时，静默 SSE 的后台读取仍可能持有模型连接。
仅等待原生连接关闭不能满足取消要求；利用同一版本请求中已验证的原生 Thread/Turn metadata，
由父进程主动中止目标请求并阻止迟到请求，保留其他会话和后续合法 Turn。该关联与清理边界
仍由工程 Spec §10.8 定义，不以普通超时、全局关闭或合成模型事件替代取消。

原生模型请求可能早于启动响应到达。固定短窗口会误拒绝仍在合法启动中的请求，而仅依据通知
转发又无法保留响应 ID 一致性检查。因此将“允许等待”与“允许转发”分开，并把持久化阶段纳入
同一次有界启动期限；具体准入与拒绝规则仍由工程 Spec §10.8 定义。
