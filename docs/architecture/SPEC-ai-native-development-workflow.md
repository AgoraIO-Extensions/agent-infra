# agent-infra AI 主导开发工作流 Spec

## 1. 文档目的

本文定义 agent-infra 的开发责任、人工检查点、AI Agent 分工、自动化边界和交付证据。
它约束仓库中的产品、架构、代码、测试、迁移和 CI 变更，不改变 Agent 平台 M1 的产品
范围或运行时架构。

本文合并后生效。开发工具、模型或编排实现可以替换，但不得绕过本文定义的人工审批、
权限隔离、确定性检查和交付证据。

## 2. 目标与非目标

### 2.1 目标

- 所有可以机械执行和自动验证的开发工作优先由 AI 完成。
- 人负责目标、约束、关键设计、测试依据、风险例外和最终 Merge。
- 每项工作都可以从需求追溯到设计、测试、实现、评审和合并结果。
- AI 在隔离环境中迭代，失败时有明确停止条件，不以无限重试代替决策。
- 人工评审聚焦需求、风险和证据，不要求逐行检查所有低风险代码。

### 2.2 非目标

- 不以“全部代码由 AI 生成”作为质量指标。
- 不让同一个 Agent 同时承担实现和最终裁决。
- 不在当前阶段自动 Merge 或自动发布生产环境。
- 不在当前阶段建设通用 Graph Engine 或 durable workflow 平台。
- 不把开发工作流并入 Agent 平台 M1 的产品功能。

## 3. 术语

| 术语 | 定义 |
| --- | --- |
| Harness | 提供上下文、权限、沙箱、规则、工具、检查和证据的执行环境 |
| Loop | 一个 ticket 内实现、验证、评审和修复的有界循环 |
| Graph | ticket、依赖、状态、并行和人工检查点组成的交付图 |
| Skill | 可复用的工作方法，不保存权威状态，也不承担调度 |
| Test Oracle | 判断行为是否正确的独立依据，包括批准的验收标准、示例和 fixture |
| Evidence Package | PR 附带的需求引用、验证结果、风险和未执行项 |

## 4. 权威来源

开发工作按以下顺序确定依据：

1. 产品行为以 [Agent 平台 M1 PRD](../prd/PRD-agent-platform-M1.md) 和
   [Connection M1 PRD](../prd/PRD-connection-M1.md) 为准。
2. 运行架构和模块边界以
   [M1 工程架构 Spec](SPEC-agent-infra-M1-engineering-architecture.md) 为准。
3. 开发责任、工作状态和自动化边界以本文为准。
4. 已批准的 issue、ADR 和接口契约只能细化上级文档，不能隐式改变上级结论。
5. `AGENTS.md`、Skills 和 Agent prompt 用于提供执行指导，不是需求或架构事实源。

发现冲突时，Agent 必须停止实现并提交 `Needs Clarification`，不得自行选择一个版本。

## 5. 责任模型

### 5.1 人的责任

- 定义问题、目标、约束和优先级。
- 批准关键设计、验收标准、Test Oracle 和测试 seam。
- 审批产品范围、身份、授权、数据归属、公开契约和迁移策略变更。
- 处理 Agent 无法消除的需求歧义、风险例外和生产权限请求。
- 审核 Evidence Package、高风险 diff 和独立评审 findings。
- 决定 Merge 和生产发布。

### 5.2 AI 的责任

- 调研代码和权威文档，形成设计草案、风险和测试建议。
- 把批准的设计拆成可独立验证的 vertical slice tickets。
- 编写测试、实现、迁移、文档和 PR。
- 运行局部与完整验证，修复可明确判断的问题。
- 在独立上下文中执行验证和评审。
- 准确报告未执行项、失败、已知风险和需要人工决定的事项。

### 5.3 确定性系统的责任

- GitHub 保存 issue、PR、review、check 和 Merge 状态。
- CI 执行不可绕过的格式、类型、测试、契约、安全和构建检查。
- Branch protection 阻止未经批准或未通过检查的变更进入 `main`。
- Hook 在 Agent 执行前后提供快速反馈和安全拦截。

AI 的自然语言结论不能覆盖 GitHub、CI 或人工审批状态。

## 6. 工作状态

### 6.1 主状态

```text
Draft
-> Needs Design Review
-> Ready for Agent
-> Implementing
-> Verifying
-> Needs Human Review
-> Ready to Merge
-> Done
```

### 6.2 异常状态

```text
Needs Clarification
Blocked
Harness Failure
CI Failure
Security Review
```

### 6.3 状态迁移规则

- `Needs Design Review -> Ready for Agent` 需要人批准设计、验收标准和测试方案。
- `Implementing -> Verifying` 需要 implementer 提交完整变更和局部验证结果。
- `Verifying -> Needs Human Review` 需要独立 verifier 和 reviewer 完成检查。
- `Needs Human Review -> Ready to Merge` 需要所需 CI 和 GitHub review 全部通过。
- `Ready to Merge -> Done` 只由受保护分支的 GitHub Merge 结果触发。
- Agent 可以提出状态迁移，不得伪造 CI、review 或 Merge 结果。

## 7. 人工检查点

### 7.1 设计检查点

每个可实施 ticket 必须包含：

- 问题、范围和不做什么。
- 可以观察的验收标准。
- 影响的领域、公开接口和数据。
- 测试 seam、关键示例和负向场景。
- 身份、授权、迁移、兼容性和生产风险。

人批准后，ticket 才能进入 `Ready for Agent`。文本修正和不改变行为的机械更新可以使用
简化设计，但仍必须声明验收方式。

### 7.2 Merge 检查点

所有变更，包括文档和自动化配置，都必须通过 PR 合并。每个 PR 至少需要一名非作者的
有权限成员批准；最后一次 push 的提交者不能批准该 PR。过期审批自动失效，未解决评论
阻止 Merge，管理员也不能绕过保护规则。

AI 不自动 Merge。人可以依据 Evidence Package 缩小 diff 阅读范围，但以下变更必须定向
检查：

- PRD、架构 Spec、ADR 和 Agent Runtime Contract。
- 身份、授权、Connection 隔离和凭证边界。
- 数据库 migration、公开 API 和兼容性策略。
- `.github/`、`.codex/`、`AGENTS.md`、Skills 和受保护测试。
- 发布、生产访问和安全基线。

## 8. Codex Agent 角色

项目初始只定义四个角色，配置保存在 `.codex/agents/*.toml`。

### 8.1 `planner`

- 读取 issue、PRD、Spec、ADR 和代码。
- 输出设计、风险、Test Oracle 建议和 acceptance criteria。
- 不修改业务代码，不批准自己的设计。

### 8.2 `implementer`

- 在单 ticket 的独立 branch、worktree 和临时环境中工作。
- 编写测试与实现，运行验证并生成 Evidence Package。
- 不能 push `main`、Merge、访问生产环境或获得生产凭证。

### 8.3 `verifier`

- 使用独立上下文和干净 checkout。
- 执行黑盒、越权、迁移、故障和回归验证。
- 可以产生忽略的构建产物，但验证结束后 tracked files 必须无变化。
- 不把 implementer 的解释或自报结果当作事实。

### 8.4 `reviewer`

- 分别检查 Spec 一致性、工程标准、安全和测试质量。
- 只产出带文件位置和严重度的 findings。
- 不修改被评审代码，不拥有 Merge 权限。

后续角色必须由真实且不同的权限或责任边界驱动，不能只因 prompt 不同而增加。

## 9. Skills

初始工程流程采用可编辑并固定上游 commit 的 Skills，不全量安装社区仓库。

采用范围：

- `grill-with-docs`
- `to-spec`
- `to-tickets`
- `implement`
- `tdd`
- `diagnosing-bugs`
- `code-review`
- `research`
- `handoff`

本地版本必须遵守以下改动：

- Spec 和 ticket 使用本仓库的权威文档及领域术语。
- `to-spec` 在发布前要求人批准 Test Oracle 和测试 seam。
- `to-tickets` 只生成可独立验证的 vertical slice，并声明 blocking edges。
- `implement` 以 PR 和 Evidence Package 为成功输出，不直接提交到 `main`。
- `code-review` 分离 Spec、Standards、Security 和 Test Quality 结论。
- `handoff` 保存结构化 Loop 状态，不以聊天摘要替代 GitHub 状态。

`loop-me` 不作为编码 Loop Engine；Claude Code 专用 Hook 和基于 Prettier 的 pre-commit
Skill 不直接引入本仓库。

## 10. Codex Hooks

项目 Hook 使用 `.codex/hooks.json` 作为唯一声明，不在多个配置文件重复定义。初始实现以
Codex 0.146.0 的 Hook Schema 为最低兼容基线；升级 Codex 前必须重新运行 Hook 契约测试和
Harness Eval。

### 10.1 事件用途

- `PreToolUse`：阻止 destructive Git、直接 push `main`、生产命令、凭证读取和工作区外
  写入。
- `PermissionRequest`：对扩大文件系统、网络、凭证和生产权限转人工处理。
- `PostToolUse`：记录工具、退出码和变更文件，并运行快速的针对性检查。
- `PreCompact`：持久化 ticket、base commit、当前步骤、失败和下一步。
- `PostCompact`：要求 Agent 重新读取权威状态后再继续。
- `SubagentStart` 与 `SubagentStop`：记录角色、ticket 和产出。
- `Stop` 与 `SessionEnd`：检查工作区、验证结果、未执行项和 Evidence Package。

### 10.2 Hook 约束

- Hook 不运行耗时的全量测试。
- Hook 不在 Agent 不知情时自动改写代码。
- Hook 输入按不可信数据解析，不使用 `eval` 或未经校验的命令拼接。
- Hook 必须有允许和拒绝 fixture，并由 CI 验证。
- Hook 只在当前文件哈希被明确信任后运行，禁止使用绕过 Hook trust 的启动参数。
- 最终规则必须由 CI 和 branch protection 重复执行。

## 11. Harness 检查

代码质量、契约、端到端、负载和故障测试以
[M1 工程架构 Spec](SPEC-agent-infra-M1-engineering-architecture.md) 第 19、21 和 24 节为准。
开发 Harness 额外规定三个检查层级。

### 11.1 快速检查

Agent 在修改过程中运行受影响范围的格式、lint、typecheck、模块测试和生成结果漂移检查。
这些检查应在秒级到分钟级返回，可以由 `PostToolUse` 或 Loop 调用。

### 11.2 PR 检查

PR CI 重复快速检查，并运行工程 Spec 要求的完整测试、契约校验、构建和安全扫描。受保护
分支只接受 GitHub required checks 的结果，不接受粘贴的日志或 Agent 自报通过。

### 11.3 定期和高风险检查

- 模块边界和循环依赖检查。
- 无效导出和死代码检查。
- 权限交集、状态机、幂等和重试的属性测试。
- 平台与 Connection 核心规则的 mutation testing。
- 负载、故障注入和受控真实 Provider 测试。

高成本检查不进入本地 pre-commit，根据风险在 PR 或定期工作流执行。

## 12. Test Oracle 与测试所有权

- 人在设计检查点批准 acceptance criteria、测试 seam、关键示例和负向场景。
- verifier 从权威 Spec 独立验证行为，不复用 implementer 的判断过程。
- implementer 可以新增单元和集成测试，但不能为通过 CI 弱化已批准的验收测试。
- 修改受保护的 acceptance fixture、权限矩阵、阈值或测试 Harness 必须触发 Code Owner
  review。
- 覆盖率用于发现空白，不作为测试质量的唯一指标；高风险模块同时观察 mutation 结果和
  缺陷检出能力。

同一个 PR 可以修改行为和相应测试，但 Evidence Package 必须解释 Test Oracle 是否改变；
Test Oracle 改变时重新进入设计检查点。

## 13. Ticket Loop

每个 Loop 只处理一个可验证 ticket，并持久化：

- issue、Spec 和 acceptance criteria 的版本或 SHA。
- base commit、branch、worktree 和当前 head。
- Agent 角色、Codex、模型、Skills、Hooks 和 Harness 版本。
- 当前步骤、重试次数、预算、命令和退出码。
- 测试结果、未执行项、diff、PR、findings 和已知风险。

### 13.1 执行顺序

```text
读取权威状态并验证基线
-> 实现一个 vertical slice
-> 运行局部检查
-> 运行所需完整检查
-> 独立 verifier 和 reviewer
-> 修复已接受的 findings
-> 创建或更新 PR 与 Evidence Package
```

### 13.2 停止条件

出现以下任一条件，Loop 必须停止并转人工：

- 需求、验收标准或 Test Oracle 存在歧义。
- 需要改变 PRD、架构边界、身份、授权、数据归属或公开契约。
- 需要生产凭证、生产访问或扩大 sandbox 权限。
- 同一失败重复出现，或达到配置的重试、时间或 token 上限。
- 需要删除、弱化测试或降低质量阈值才能继续。
- 基线失败导致无法区分已有问题和本次回归。

具体预算由执行环境配置，不写入产品 PRD。没有预算配置时，Loop 不得无人值守运行。

### 13.3 成功条件

Loop 的成功输出是可评审的 `PR + Evidence Package + 已知风险`。创建 commit、测试部分
通过或 Agent 声称完成都不构成成功。

## 14. Graph 与调度

GitHub 是开发 Graph 的权威来源：

- Issue 保存目标、acceptance criteria、状态和 blocking edges。
- PR 保存实现、review 和讨论。
- Actions/Checks 保存确定性检查结果。
- Branch protection 和人工审批决定 Merge。

未来首个 dispatcher 只选择状态为 `Ready for Agent`、blockers 全部完成且位于批准允许范围内
的 frontier ticket，每个节点启动一个独立 Loop。LLM 不计算或覆盖权威依赖状态。

当前不引入 LangGraph.js 或 Temporal。只有出现跨天精确恢复、复杂 fan-out/fan-in、大量
人工 interrupt 或补偿流程后，才通过 ADR 评估 durable orchestration。即使引入，GitHub
仍是交付状态的权威来源。

## 15. GitHub 控制

### 15.1 `main` 保护

- 仓库公开可读，`main` 只接受 PR 合并。
- 每个 PR 至少需要一名非作者批准。
- 新 push 使旧审批失效，最后 push 者不能批准。
- Code Owner review 和评论解决是合并前置条件。
- 管理员遵守相同保护规则。
- 禁止 force push 和删除 `main`。
- 要求线性历史，不允许 AI 自动 Merge。

### 15.2 权限

- 无人值守 Agent、dispatcher 和自动化 Runner 使用独立 GitHub App 或服务身份，不复用
  个人长期 Token。
- 人工监督的本地 Codex 会话可以使用操作者当前 GitHub 身份，但不能作为独立审批人，
  也不能在会话结束后继续无人值守运行。
- AI 身份不具有仓库 Admin、规则绕过或生产权限。
- Contents 写权限只用于工作分支；Issue 和 PR 权限按职责授予。
- 第三方 GitHub Actions 固定完整 commit SHA，不使用浮动 tag。

### 15.3 Code Owners

以下范围必须指定能够承担责任的 Code Owner：

- PRD、架构 Spec 和 ADR。
- `.github/`、`.codex/`、`AGENTS.md` 和 Skills。
- 身份、授权、Connection、凭证边界和 Agent Runtime Contract。
- migration、公开 API 和受保护的 acceptance tests。

工程脚手架生成前只声明已存在的文档与自动化路径，不创建不存在的代码目录占位规则。

## 16. Evidence Package

每个 PR 必须提供：

- 来源 issue、Spec 和 acceptance criteria。
- base/head commit 和变更范围。
- 设计决策与 Test Oracle 是否变化。
- 已执行命令、结果和对应 GitHub checks。
- 未执行检查及原因。
- verifier/reviewer findings 及处理结果。
- migration、公开契约、安全和兼容性影响。
- 截图、日志或其他必要的行为证据。
- 已知风险、回退方式和需要人工关注的 diff。

Evidence Package 不保存模型内部思考、凭证、普通用户会话正文或无关命令输出。

## 17. Harness Eval 与自治升级

开发 Harness Eval 与产品 Roadmap 中的 Agent Eval 分开维护。它使用真实历史 ticket、
seeded bug 和权限攻击样例，多次运行以观察非确定性。

至少记录：

- 首次 CI 通过率和最终任务成功率。
- 独立 verifier 的 acceptance pass rate。
- 人工 review 时间和 findings 严重度。
- escaped defect、回滚和重复失败。
- 需求外改动比例。
- mutation 结果和安全边界绕过次数。
- 重试、耗时和资源消耗。

自治按以下顺序升级：

1. AI 生成设计和 PR，人执行所有状态迁移。
2. AI 在单 ticket Loop 中自动修复，人批准设计和 Merge。
3. Dispatcher 自动领取 ADR 明确允许的 frontier tickets，人批准设计和 Merge。
4. 更高自治必须由新的 ADR 和 Eval 证据批准。

本文不授权自动 Merge。

## 18. 实施顺序

1. **仓库控制：** 公开仓库、保护 `main`、建立 Code Owners、PR 模板和文档 CI。
2. **Harness 基线：** 安装固定 Skills、定义 Codex roles 和 Hooks、补充真实验证命令。
3. **单 ticket pilot：** 在独立 worktree 运行 Loop，生成 Evidence Package。
4. **Eval 基线：** 对固定任务重复运行，记录人工时间、成功率和失败类型。
5. **自动派发：** Eval 支持后再实现 GitHub frontier dispatcher。

每一步使用独立 PR，并在前一步通过人工评审后开始下一步。

## 19. 验收标准

- 匿名用户可以读取仓库，`main` 保护规则可通过 GitHub API 回读。
- 直接 push、force push、删除 `main` 和无审批 Merge 均被拒绝。
- 所有正式开发工作可以从 issue 追溯到设计批准、PR、CI、review 和 Merge。
- 四个 Codex 角色具有不同责任和最小权限，verifier/reviewer 不修改被评审代码。
- Hooks 的允许和拒绝 fixture 在 CI 中通过，危险命令被阻止，普通开发命令不被误拦截。
- AI 不能通过修改测试、阈值、CI 或 Harness 绕过失败。
- 每个 Loop 达到停止条件后进入明确异常状态，不无限重试。
- PR 包含完整 Evidence Package，未执行检查不会被表述为通过。
- 自动派发前已有可重复的 Harness Eval 基线。
- 仓库不存在 AI 自动 Merge 或自动生产发布路径。
