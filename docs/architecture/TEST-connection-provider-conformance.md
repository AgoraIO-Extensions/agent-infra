# Connection Provider 测试计划

本文落实 [Connection M1 HLD 的测试策略](HLD-connection-M1.md#31-测试策略与验证证据)，不改变
Provider、授权、Credential、Effect 或恢复边界。

## 测试清单

测试直接读取正式 Provider catalog。每个 Action 自动获得以下测试归属：

- `READ`：Adapter contract UT 和真实测试项目 read smoke。
- `WRITE`：Adapter contract UT 和真实测试项目 isolated mutation。

新增 Action 若没有合法 `READ` 或 `WRITE` effect，或者 Action ID 重复，测试必须失败。真实 E2E
证据必须记录 ProviderRelease、ActionVersion、run ID、Provider request/idempotency ID 和 Call/Effect
终态；本地或 Fake 测试不能标记为真实 Provider 验收。

## 测试项目

每个 Provider 使用独立测试账号和固定测试容器：GitHub organization/repository、Bitbucket
project/repository、Jira project、Confluence space。优先使用独立 test tenant；共用站点时，测试账号
只能拥有测试容器权限。

真实 mutation 默认关闭。执行前必须同时验证：

1. 测试模式已显式启用。
2. 当前 Provider、tenant immutable ID 和 container immutable ID 与获批配置完全一致。
3. 本次运行有非空 run ID。
4. 创建内容包含 `connection-e2e:<runId>` ownership marker。
5. update/delete 的对象 ID 来自本次运行记录，且 Provider、tenant、container、run 和 marker
   全部匹配。

任一条件不满足时，在调用 Provider 前失败。名称前缀不能替代 immutable ID 校验。

## CRUD 生命周期

每个支持 mutation 的资源按 `create -> read/list -> update -> read -> delete -> read-not-found`
执行。`finally` 清理本次运行记录的资源；定时 sweeper 只处理 marker 有效且超过 TTL 的遗留资源。
清理失败必须保留证据并使该 Provider 验收失败，不能尝试删除测试容器之外的对象。

不适用 CRUD 的 workflow Action（例如 approve、merge、transition）使用本次运行创建的资源验证
真实状态迁移，随后执行同样的 ownership 校验和清理。

### GitHub Actions E2E

GitHub 的第一条真实闭环由 `Connection GitHub E2E` workflow 执行。它使用固定的生产 Connection
MCP endpoint 和确定性 Action 序列，不运行 Codex 或其他模型。执行边界固定为：

- Provider Connection external account ID：`328682695`
- organization：`AgoraConnectionE2EORG`（ID `329053903`）
- owner：`AgoraConnectionE2EORG`
- repository：`connector-conformance`
- repository ID：`1369705971`
- visibility：`private`
- default branch：`main`

workflow 只在 repository variable `CONNECTION_GITHUB_E2E_ENABLED=true` 时运行，并从受保护的
`connection-e2e` Environment 读取 `CONNECTION_E2E_TOKEN`。该 token 只授予专用 Connection CI
ConsumerInstance；GitHub OAuth credential 不进入 GitHub Actions。GitHub-hosted `ubuntu-24.04`
必须能访问 Connection endpoint；网络不可达时本次运行失败，不能自动切换 runner 后重放 mutation。
若长期不可达，需经评审把 workflow 固定迁移到受控 self-hosted runner。

受监督验收通过 `workflow_dispatch` 从 `connection` ref 加载 workflow，并将 checkout 固定到本次
dispatch 对应的不可变 `github.sha`。GitHub schedule 只加载默认分支上的 workflow；默认分支未同步
该定义时，scheduled run 不作为 `connection` 分支的验收证据。

当前生命周期覆盖 Issue 和 comment 的创建、读取、更新、删除 comment 与关闭 Issue，以及专用测试
仓库内可逆的 ref、label、Issue metadata、file、topics、star、milestone 和 release mutation。暂不执行
repository 删除、协作者变更、fork、workflow 或 merge mutation。
九个 lifecycle Action 固定使用已批准的 `@v7` ActionVersion；catalog 升级必须先更新测试基线并评审，
不能由 nightly 自动接受新版本。

当前 GitHub v7 catalog 共 145 项，其中 109 项具有 run `34929778284-1` 的真实 Provider 证据：77 个
`READ` 和 32 个 `WRITE`。`github.get_pull_request_review@v7` 因缺少第二测试账号保持
`UNVERIFIED`，其余 35 个 `WRITE` 也保持 `UNVERIFIED`。版本升级后旧证据不继承。本阶段只更新验证
矩阵，不改变 production discovery、Grant、declaration 或 execution eligibility；对外门禁在更多
Action 完成 E2E 后另行启用。Bitbucket、Jira 和 Confluence 必须分别完成验证，不能把 GitHub 证据
外推到其他 Provider。

## 测试层级与门禁

- 每个 PR：UT、Adapter contract、PostgreSQL integration；不访问第三方站点。
- 合并后：真实 Provider read smoke，只读取专用测试项目。
- Nightly：所有已批准 Action 的测试项目 CRUD/workflow E2E。
- 发布前：增加 revoke/reauth、429、timeout、response-lost、crash/restart 和 reconciliation。

发布证据要求 catalog Action 覆盖率 100%、测试容器外 mutation 为零、遗留对象为零、重复外部
Effect 为零，并且没有未解释的 `UNCERTAIN`。真实 E2E 未运行时必须明确报告 `NOT_RUN`，不得用
UT、Fake、CLI 或其他产品的成功代替。
