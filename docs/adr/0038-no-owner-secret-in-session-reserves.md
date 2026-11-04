# ADR-0038：新会话预留实例不预先持有 Owner Secret

## 状态

已采纳。负责人在 [#3924](https://github.com/AgoraIO-Extensions/agent-infra/issues/3924) 确认了 D-1 至 D-6，本文随该票的文档评审合入。预留、领取和回收的合同仍以[工程 Spec 新会话预留实例](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#新会话预留实例)和 [ADR-0036](0036-bounded-session-sandbox-reserves.md) 为准；本文只记录不把预留实例扩展到 Owner Secret 的理由和重新评估条件。

## 背景

2026-11-04 的架构评审对比了 3c1f0660 的 ACK 浏览器样本：custom r2/r3 首轮从点击到受理为 80.8–81.6 s（N=2），使用预留实例的标准模板为 2.0–3.7 s（N=4）。样本很小，custom 首轮内部的分段尚未测量，由 [#3921](https://github.com/AgoraIO-Extensions/agent-infra/issues/3921) AC-3 跟踪。评审首选让 custom Agent 也使用预留实例。

[PRD §3](../prd/PRD-agent-platform-M1.md#3-agent-运行方式) 只允许为标准模板准备备用实例。工程 Spec 规定未领取实例的 Secret 不包含 Owner Secret，custom Owner Secret 保持原准备路径。按当前实现，只放开资格条件得不到收益：

- `platform-adapter` 自定义 Agent 不生成标准模板 V4 模型投影，由镜像自己装配模型；Session 准备要求至少一个 Owner Secret。
- Owner Secret 通过 `secretKeyRef` env 进入不可变的 Session Secret 和 Pod。领取后再交付只能重建 Pod，而重建后的 Pod 不算预留命中。
- 因此收益只能来自在未领取实例中预先物化 Owner Secret，也就是在没有 Conversation、Execution 和业务授权时，让客户镜像持有 Owner 凭据并运行。

## 决策

1. 备用实例继续只用于标准模板，PRD §3 不变。`platform-adapter` 自定义 Agent、自有交互入口和多服务 Agent 走原准备路径；多服务只支持 self-managed，见[工程 Spec §10.12](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1012-builder-与多服务自定义-agent)。
2. 未领取实例不预先持有 Owner Secret，也不采用限定数量、TTL 或轮换淘汰的受限持有方案。
3. 未领取实例“没有业务状态”的证明保持 ADR-0036 首版：实际六类资源、Host bootstrap `/healthz`、全新 PVC 和原始资源 UID。这组证明只适用于获准的标准模板镜像，不用于证明客户镜像没有产生外部副作用。
4. custom 冷路径的优化只采用不改变凭据边界的方式：发布与部署阶段的 ECI 镜像缓存（[#3931](https://github.com/AgoraIO-Extensions/agent-infra/issues/3931)，不算预留命中），以及 #3921 的同源阶段测量。

## 理由

- 客户镜像是 Owner 提供的代码。它持有凭据后，可以在领取前访问外部系统，平台既观察不到也撤销不了这类副作用。`/healthz`、全新 PVC 和原始 UID 只能证明平台侧的资源是干净的。
- 预先持有会扩大凭据暴露面。每个备用实例在空闲期间都持有一份可用的 Owner 凭据；Secret 轮换、Agent 停用或 Owner 变更时，必须先淘汰全部未领取实例，否则旧凭据会继续运行。
- 收益未知。custom 首轮中 Pod 创建、镜像拉取、Host 启动和原生准备各占多少尚未测量，镜像缓存可能已经覆盖其中的主要部分。

## 影响

- custom 首轮仍走冷路径，耗时以 #3921 AC-3 的测量为准。
- Store 资格检查中由 #3929 加入的 custom 分支不可达：custom Agent 没有 V4 投影，校验总是失败。按本决定收回并补负向测试，见 [#3937](https://github.com/AgoraIO-Extensions/agent-infra/issues/3937)。
- 工作区快照只允许 custom Agent 使用，所以目前没有能进入预留的快照 Agent。预留 Pod 的渲染不包含快照投影；以后重新评估时，须先让预留 Pod 与正式 allocation 使用相同的快照投影，否则领取后的 Pod 校验会以 `conflict` 失败。
- 正式 Session 中 Owner Secret 的物化来源与工程 Spec 不一致，由 [#3938](https://github.com/AgoraIO-Extensions/agent-infra/issues/3938) 单独修正，与本决定无关。

## 备选方案

| 方案 | 结论 |
| --- | --- |
| 未领取实例预先物化 Owner Secret，并限制数量和 TTL，在轮换或停用时淘汰 | 否决，理由见上。 |
| 领取时再写入 Owner Secret | 否决。Session Secret 不可变，重建 Pod 不算命中；就地修改在用对象违反工程 Spec。 |
| 领取后由 Runtime 主动获取凭据 | 暂不选。客户镜像需要实现新的凭据获取契约，还需要原生状态隔离验收；ADR-0036 也因为需要新的 Runtime 激活合同而没有采用领取后重绑。 |
| 只做镜像缓存 | 采用，作为冷路径优化，不算预留命中。 |

## 重新评估条件

同时满足以下两点才重新评估：#3921 的同源测量显示，启用镜像缓存后 Pod 创建和 Host 启动仍占 custom 首轮的主要部分；并且已有经过评审、不要求未领取实例持有 Owner 凭据的激活方案。
