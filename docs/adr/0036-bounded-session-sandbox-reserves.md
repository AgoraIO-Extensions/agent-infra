# ADR-0036：固定最终身份的新会话预留实例

## 状态与决策

提案，归属 [#3773](https://github.com/AgoraIO-Extensions/agent-infra/issues/3773)。
产品范围以 [PRD §3](../prd/PRD-agent-platform-M1.md#3-agent-运行方式)为准，预留、领取、
回收和预算的完整合同只在[工程 Spec §10.1.1](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#新会话预留实例)定义。
本文不表示预热已实现、部署或达到秒级；实现必须在本设计评审后单独交付。

采用按 Agent 及已验证配置准备的新会话预留实例。提前生成最终 Session/Sandbox ID 对，
Pod 使用最终身份，真实用户领取时保持 ID、Pod 和 PVC 不变。沿现有 Platform DB/Worker
实现一次性分配，首阶段只支持无 Owner Secret 的标准模板，不增加通用 Runtime 身份重绑接口。
首版只预先完成计算、镜像和 Host bootstrap。原生 Session 仍在真实授权投递时准备，其等待
完整计入可执行耗时；不能将预留池命中或 `/healthz` 当作原生进程已暖。

## 选择理由

当前 Pod env 固定 Agent 身份，Codex 容器边界 attestation 固定 Agent/Session；
Sandbox 服务 token 固定 namespace/Sandbox，文件交换 token 还固定 generation/resourceFence。
PVC、Secret、Service、ServiceAccount、NetworkPolicy 与 Pod 同属唯一 Sandbox。
只改标签或在领取后更换身份，不能保持这些输入一致。预留最终 ID 避免修改在运行 Pod 的
env、卷与 immutable Secret，但需要独立预留事实和原 Conversation 事务中的一次性领取。

| 方案 | 取舍 |
| --- | --- |
| 仅镜像/PVC 预热 | 可以辅助降耗；仍需创建计算实例和初始化 Host，不能单独作为运行实例预热的完成证据。 |
| 通用空白 Pod，领取后更换 Agent/Session | 当前 env、attestation、Secret 和卷不支持原地重绑；需要新的 Runtime 激活合同，本次不选。 |
| 同 Agent/config，预留最终 ID 对 | 选用；资源不改身份，维护现有 Runtime 入口，代价是 profile 数量、预留成本和独立 Store 领取规则。 |
| 引入 provider SandboxSet/SandboxClaim 或通用 pool SDK | 暂不选；新增控制器/资源适配并不能消除平台主体、immutable Secret、PVC 和停止屏障的映射工作。 |
| 已用 Sandbox 清空后归还 | 不选；清空证明、残留进程/凭据和历史隔离风险不值得承担，已领取实例终身只属原 Session。 |

参考 [Magic 的原子领取](https://github.com/dtyq/magic/blob/0f1432c329ff4010df86252b963a32795e23d090/backend/magic-service/app/Domain/SuperMagic/Task/Service/WarmPoolSandboxDomainService.php)
及[后台补充](https://github.com/dtyq/magic/blob/0f1432c329ff4010df86252b963a32795e23d090/backend/magic-service/app/Application/SuperMagic/Task/Service/WarmPoolSandboxAppService.php)，
采用领取与补充分离、按镜像版本匹配及淘汰失败实例的思路；不照搬其动态工作区挂载。
[Daytona](https://www.daytona.io/docs/en/warm-pools/) 的固定配置与配额限制、
[OpenSandbox](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/guides/client-pool.md) 的
一次性领取和空池策略也可借鉴，不据上游速度描述承诺本平台延迟。

## 首轮验证配置

默认关闭，先为一个获准 Agent/profile 验证，再依次覆盖四个标准模板。试验配置为该 profile
最小备用 1、最大 2，总备用上限 4、同时创建最多 1；同时记录明确的部署总计算和存储预算。
资源规格使用已通过容量准入的原规格，不通过减少资源后冒用旧容量证明。配置、缺额和正在创建
的实例都必须可回读；测试结束把目标归零，只清理未领取预留资源。

备用目标可按 `ceil(新会话到达率 × 补充耗时) + 突发余量` 估计并受上述上限约束。
使用固定测量窗口，以最近实际补充样本计时；低流量阶段先验证固定最小值与上限，随后用
可重复的流量轨迹验证动态目标、冷却和失败退避，不能先加复杂预测器。
费用按预留的实际计算规格、存在时长和 PVC 占用计算；领取后的活跃资源另列并仍计总预算，
不能把低 CPU 使用率当作未计费。价格从目标地域实际计费配置取得，不在 ADR 写过期单价。

## 验收与后续实现

| 范围 | 必需证据 |
| --- | --- |
| 秒级目标 | 工程目标为命中时创建新会话至实际可投递 1–3 秒；测量包含授权、原子领取、Worker 实际资源检查与原生准备，模型 TTFT 单列。四模板各自在固定 source/image/config 下重复；目标不是已测结果。 |
| 请求分布 | 固定 1/10 并发、持续流量和超出总备用数的突发；分别报告命中、缺池、冷启动、超时/失败及样本数。小样本不宣称生产 p95。 |
| 原子领取 | 同一幂等请求并发重放只有一组 ID；不同主体争抢同一项只成功一个；事务回滚、进程在提交前后退出、响应丢失均不重复分配。 |
| 无业务授权的预留 | 领取前没有真实 Conversation/Execution，文件、模型和 Connection 请求拒绝；凭据不泄漏到原生工具；另一主体/Session/Agent 不能访问其资源。 |
| 资源与回收竞争 | 领取和淘汰竞争、过期清理器、旧 create 响应、部分创建、DELETE 响应丢失和同名新 UID；全部按原始事实恢复，不删除已领取资源或释放未知占用。 |
| 升级与预算 | profile/key/policy 变更使旧项不可领取；多 Worker 补充不超配，已领取占用不释放总预算；关闭、预算调低及缩容只回收未领取项。 |
| 业务保持 | 真实模型、工具、文件交换、授权负向、会话多轮及重启恢复；原 Session ID/PVC/history 保持，custom 与 self-managed 走原路径仍成功。 |

实现拆成三个明确范围：

1. `platform-core`/`platform-store` 与 migration：预留事实、预算、原入口事务领取，保留
   Conversation 复合外键与原幂等；真实 PostgreSQL 并发、失败恢复和隔离测试。
2. `platform-worker` 与部署配置：未领取资源准备、原始 UID 接收、条件清理、容量补充和
   关闭；首版只检查六资源、Host bootstrap 与无业务状态，不以假主体适配旧 claim，
   不使用 Agent 级 readiness JWS 代替预留授权。原生进程预热或新探测 wire 留待单独评审。
3. 部署与业务验收：真实 ACK 中受上限约束的同源对照，完整功能回归、成本与可比耗时；
   未达到目标时保留指标与问题，不以文档、Pod Ready 或合成 receipt 关闭性能父票。

每个实现 Issue 开始前冻结具体文件和 owner；本文不授予替其他 Session 修改源码或占用
其验收资源的权限。首次全冷部署补满预留池仍需时间，已有回收 Session 的原 PVC 恢复也
不因此变成命中；两者在 [#3692](https://github.com/AgoraIO-Extensions/agent-infra/issues/3692)
分别跟踪。禁用预留后停止新预留和领取，已领取项只沿既有会话生命周期处理。
