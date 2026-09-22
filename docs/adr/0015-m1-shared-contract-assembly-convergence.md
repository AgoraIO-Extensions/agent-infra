# ADR：#670 M1 共享契约与最终装配收口

- 状态：已决议，作为 #670 的交接决策
- 日期：2026-09-22
- 基线：`origin/main` `76d6ecc10ce8bc9a6c69a7d655e903c52fdd9a6d`
- 范围：#506 拆分后的 contracts、vendor、Runtime/Host、Platform/local、Web

## 决策

M1 只保留一条从契约到真实启动的装配链：

```text
#629 callback contracts ─┐
                         ├─> #630 contracts ─> #639 Runtime/Host ─> #643 Platform/local ─> #638 Web consumer
#637 frozen vendor ──────┘
```

Issues #629、#630、#637 只交付冻结输入、契约生成物和读取适配；它们不宣称 Runtime、身份、模型、Connection 或四模板真实验收。#639 和 #643 是行为交付票，分别拥有 Runtime/Host 与 Platform/Worker 的缺失行为。#638 只拥有 Web 消费行为。任何切片都不得复制另一个切片的 schema、store、worker、RuntimeHost 或页面实现。

契约进入 `main` 后，后续 PR 必须直接以最新 `main` 为 base，只携带本票差额。拆分票关闭不关闭原功能票；原功能票继续承担其完整 AC、真实身份、模型、四模板和 Connection 联合验收。

## Ownership 与消费边界

| 领域 | 唯一 owner | 主要路径 | 允许消费 | 明确不拥有 |
| --- | --- | --- | --- | --- |
| Callback / Runtime / Pilot contracts | #629、#630 | `packages/contracts`、生成 artifacts | PRD/Spec 定义的版本化 HTTP、SSE、Host、Grant、事件和生成 client | 业务规则、数据库权威、Runtime driver、页面 |
| Codex vendor inputs | #637 | `deploy/runtime/vendor/codex` | 固定上游 source、patch、manifest、probe 的字节和摘要 | native 编译/替换/发布、Runtime 语义、凭证和 Connection 授权 |
| Runtime / Host | #639 | `packages/agent-runtime`、`apps/agent-runtime-host` | #630 的 Host/Grant/event contracts、#637 的固定安装输入 | Platform DB、Hono 业务路由、Kubernetes 期望状态、Web 状态 |
| Platform / local assembly | #643 | `packages/platform-core`、`packages/platform-store`、`apps/platform-api`、`apps/platform-worker`、`migrations/platform`、`deploy` | #630 的 public contracts、#639 的 RuntimeHost client/driver boundary | Runtime driver 内部、vendor source、浏览器状态、Connection DB/凭证 |
| Web management / conversation | #638 | `apps/web` 及其 consumer tests | #630 生成 client、Platform HTTP/SSE 的公开状态和错误语义 | 身份/授权判断、数据库读写、Runtime/模型选择、合成数据 |
| Actual execution facts | #508 先行、#483 补齐 | Runtime 实际模型/工具边界、Platform durable consumer | 同一版本化事实 schema、intent/result、事件 cursor 和审计事务 | 自报 callId、日志反解析、第二套事实 schema |
| Audit / observability consumers | #484、#441 | Platform query/management 与运行观测入口 | #508/#483 持久事实及 Platform 审计 | 重新生产执行事实、改变任务结果、Connection 审计投影 |

Platform DB 是 Agent、会话、任务、授权、事件和审计的权威；Kubernetes 只保存实际 workload 状态。`platform-api` 负责身份解析、授权和 HTTP/SSE 接入，`platform-core` 负责领域规则，`platform-store` 负责事务持久化，`platform-worker` 负责 claim、dispatch、恢复和 RuntimeHost client。RuntimeHost 只接受版本化内部 contract；它不读取 Platform DB，也不接收原始 Connection 凭证。

## 消费顺序与交接

1. 合入 #629，再合入 #630；生成 client、Host、Grant、事件和 Pilot artifacts 的版本与摘要在此处冻结。
2. #637 只在 callback corpus 可消费后合入，逐字节验证 vendor 输入和来源摘要；不得把安装脚本通过当作 native 或真实 Runtime 验收。
3. #639 消费 #630/#629/#637，交付 Runtime/Host 行为、恢复、隔离、安装准入和拒绝路径；其 PR 不重新提交 contracts 或 vendor。
4. #643 消费 #630 与 #639，完成 Platform API/Worker、Platform DB migration、local deployment assembly、唯一 dispatch/store/host seam；其 PR 不重新实现 Runtime driver。
5. #638 消费 #630 的 generated client 和 #643 暴露的公开 HTTP/SSE；它可以在 #630 后并行做页面，但正式 consumer acceptance 必须针对 #643 的当前 `main`，不能用 mock/fixture 代替真实 API。
6. #508 维护唯一生产工作发现、claim、授权、投递、事实 intent/result、事件和必要审计基础；#481、#482、#483 在该 seam 上补齐各自的完整产品行为。#484 和 #441 只读取同一持久事实。

## 基线事实与未完成行为

基线已经包含可生成的 RuntimeHost/Pilot contracts、callback corpus、四类 Runtime driver/core conformance、RuntimeHost HTTP/SSE 入口，以及 Platform API 的 assembly loader 和 Platform Worker 的 dispatch factory。这些是可消费的技术资产，不等于正式 M1 闭环。

以下事实仍必须由对应唯一实施票完成并以正式启动入口证明：

- `apps/platform-api` 的 deployment assembly 必须连接当前身份、Platform Store/Core、公开 API/SSE 和审计事务；不能只通过路由或组件测试。
- `apps/platform-worker` 必须从持久 work item 唯一发现/claim，沿同一 store/事件/审计事务投递到真实 RuntimeHost；heartbeat 或孤立 `dispatch()` 调用不构成生产循环。
- RuntimeHost/Driver 必须在实际模型/工具边界记录 intent、结果/unknown、耗时和可得用量；Schema、SDK mock、整体 Turn 耗时或模型自报不构成 #483 事实。
- Web 的管理、对话、任务、SSE 恢复和执行详情必须消费当前 API 返回的主体/授权/事件状态；页面测试不能改变服务端授权，也不能用合成数据证明真实首通。
- #481、#482、#483、#484、#441、#508 的完整 AC 保持独立；拆分产物只回填已经满足的代码和验证证据，不把“schema 存在”“组件测试通过”或“Issue closed”标记为真实验收完成。

## 唯一装配 seam

正式本地/集成验收必须启动同一条 `Web → Platform API → Platform DB/Store → Platform Worker → RuntimeHost → Runtime Driver` 路径。允许在 contract、Core、Store、RuntimeHost client 和 Driver 边界使用 conformance doubles 做单元/契约测试，但验收证据必须另外包含真实 PostgreSQL、Worker lease/claim、不可变 Runtime 配置和至少一个已验证 standard Driver。不能通过直接构造 Execution、手工调用 dispatch、healthz、旧 AO session 或单独组件测试绕过这条路径。

外部 Connection 仍是独立直连系统。Platform 只保存可信关联引用；Connection 凭证、外部状态和 Connection 审计由 Connection 侧拥有。跨主体、跨 Agent、跨 Connection 的负向访问必须从正式 API 和查询入口验证。

## 完成门禁

每个拆分 PR 的局部门禁：冻结源逐路径映射、当前 main 差分、生成物/摘要验证、类型与相关测试、仓库规定检查、Standards/Spec review、当前 head checks 和 review threads。不得覆盖 main 的新实现或从旧聚合分支重复提交。

汇合门禁：

- **装配**：从正式入口完成至少一条真实 Web→API→Worker→Pod→RuntimeHost→SSE journey；记录 commit、镜像/配置 digest、迁移版本和脱敏 artifact。
- **授权与隔离**：使用正式用户/应用身份验证资源隔离、凭证失效与主体撤权；不能把 Owner、责任人或旧 session 当作调用方身份。
- **恢复与副作用**：覆盖重启、租约接管、SSE 重连、取消竞态、投递前后崩溃和 unknown；可能已发生的外部操作不能盲重试或换 ID。
- **事实与审计**：#483 的实际模型/工具证据、#484 的查询和 #441 的观测均能回读同一 execution/operation/attempt 关联；正文、附件、思考和凭证不进入事实/审计/观测。
- **联合验收**：#194 负责本地主链路，#435 负责 Connection 联合 Pilot，#150 负责完整 M1 汇合。拆分票和本 ADR 不代签这些入口。

## 原功能票交接

| 继续作为唯一实施入口 | 共享交接内容 | 仍由原票完成 |
| --- | --- | --- |
| #508 | 唯一 claim/dispatch/Runtime facts intent/result/audit seam，Codex 基础 | 可信 Codex 真实模型/工具、隔离和正式启动证据 |
| #481 | Platform Agent/模型/授权 API 的主体与凭证事实 | 完整管理 API、真实身份和授权负向矩阵 |
| #482 | 同一 Execution/Store/Worker/RuntimeHost 路径 | 用户/应用任务 API、等待/取消/恢复和完整故障矩阵 |
| #483 | 同一事实 schema、cursor、intent/result 和审计事务 | 四模板实际模型/工具、Connection 关联和崩溃一致性 |
| #484 | 读取 #483/#508 的持久事实与 Platform 审计 | 审计 API、范围授权和管理视图 |
| #441 | 读取同一 execution/operation/attempt 元数据 | 日志、指标、Trace、告警和导出故障语义 |

本 ADR 不新增功能、不改变 PRD 或 HLD 的授权边界；若实现发现需要改变语言、数据归属、部署单元、身份传递或 Runtime contract，必须先更新对应架构权威文档并重新评审。
