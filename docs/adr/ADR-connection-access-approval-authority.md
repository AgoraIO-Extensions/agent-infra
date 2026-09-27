---
status: accepted
---

# Connection Access Approval is an independent authority

Personal Provider Connections require a company approval before Provider OAuth or credential input. Connection therefore owns a versioned Connection Access Policy, an immutable staged Request and Decision history, a server-only take-once Connect Permit, and a continuing Connection Access Authorization. These objects are independent from Provider OAuth scope and Consumer Grant because they answer different questions at different times: company eligibility to connect, Provider proof of an external account, and Consumer permission to invoke Actions.

The alternative of reusing Connection Grant was rejected because a Grant exists only after a Provider Connection and binds a Consumer, while company approval must happen before Credential collection and applies regardless of Consumer. UI-only checks and expiry workers were rejected because OAuth callbacks, PAT/API Key endpoints, reconnect paths and delayed workers could bypass them. Every personal connection path consumes the same Permit, and every invocation plus final dispatch admission rechecks the current Access Authorization revision, database time and execution fence.

This adds durable policy, approval, permit, authorization, audit/outbox and notification state. It deliberately keeps shared Connection approval, automatic organization routing, arbitrary approval DAGs, automatic approval, break-glass and external notification channels outside the initial scope.

## Compatible Provider upgrades

公司审批约束的是个人 Connection 的获批能力上限，不是 Provider 目录的总能力数。可证明兼容的升级继承原批准和剩余有效期，保留使用者对 Consumer 的能力选择；新增能力不默认加入。扩权、换号或无法证明兼容时先重新审批。具体迁移、兼容性证明与并发约束以 [HLD 16.7](../architecture/HLD-connection-M1.md#167-connection-access-approval) 为准。

原审批来源与当前可执行版本必须分别可追溯：保留历史 Request/Decision 的精确版本绑定，以受控迁移关联目标版本，且原策略撤销和重审继续生效。拒绝两个替代方案：所有版本变化一律重新审批会重复审核未变化的权限；只放宽版本比较或按 Action 名称继承会允许执行语义变化和新增能力绕过审批。
