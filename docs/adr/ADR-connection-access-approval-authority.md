---
status: accepted
---

# Connection Access Approval is an independent authority

Personal Provider Connections require a company approval before Provider OAuth or credential input. Connection therefore owns a versioned Connection Access Policy, an immutable staged Request and Decision history, a server-only take-once Connect Permit, and a continuing Connection Access Authorization. These objects are independent from Provider OAuth scope and Consumer Grant because they answer different questions at different times: company eligibility to connect, Provider proof of an external account, and Consumer permission to invoke Actions.

The alternative of reusing Connection Grant was rejected because a Grant exists only after a Provider Connection and binds a Consumer, while company approval must happen before Credential collection and applies regardless of Consumer. UI-only checks and expiry workers were rejected because OAuth callbacks, PAT/API Key endpoints, reconnect paths and delayed workers could bypass them. Every personal connection path consumes the same Permit, and every invocation plus final dispatch admission rechecks the current Access Authorization revision, database time and execution fence.

This adds durable policy, approval, permit, authorization, audit/outbox and notification state. It deliberately keeps shared Connection approval, automatic organization routing, arbitrary approval DAGs, automatic approval, break-glass and external notification channels outside the initial scope.
