# ADR-0053：Execution 结束后保留会话级 Connection 授权入口

## 状态

提案，归属 [#4480](https://github.com/AgoraIO-Extensions/agent-infra/issues/4480)。本 ADR 记录
用户 2026-11-24 的授权边界决定；完整合同以[工程 Spec §13.5.6](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1356-标准-oauth-安装供应)
和[§13.5.7](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1357-agent-关联与-oauth-安装准备)为准，
产品行为以[Platform PRD §9.1](../prd/PRD-agent-platform-M1.md#91-owner-按需关联与用户-oauth)为准。

## 背景

原安装入口要求存在仍在处理的 Execution。Connection 调用被拒绝后，使用者无法在原会话完成
授权并重试，导致授权入口错误地依赖一次已经结束的业务执行。用户决定不挂起或延长 Turn，改为
保留会话中的授权入口，让使用者完成本人授权后在同一会话重试。

## 决策

- 拒绝的 Connection 调用按原规则结束当前 Turn；平台不挂起、延长或恢复该 Turn，也不为授权
  新建业务 Turn。
- Web 授权入口属于会话，即使触发拒绝的 Execution 已结束仍可用。使用者完成本人授权后，
  后续合法 Execution 可在同一会话重试。
- 授权和安装绑定仍固定原用户、Agent、Session、Consumer/Instance、当前授权修订、代次及
  其他既有 fence。后续 Execution 只能在合法 claim 下向对应 Host 供应安装凭据；调用方不能选择
  Runtime、Pod、主体、Consumer、scope 或凭据。停止、停用、代次隔离、主体不匹配和无法确认当前
  授权仍拒绝。
- Connection 继续独立负责主体、Consumer、Instance、Grant、外部授权、凭据保管和撤销；不新增
  队列、身份或凭证服务，不把 Platform 变成 Connection 代理。

## 备选

- 挂起原 Turn 直到用户完成授权：未采用，会延长业务 Turn 并保留不应继续占用的执行位置。
- 强制新建会话后再授权：未采用，会丢失使用者当前会话的连续性，且与产品决定不符。
- 让调用方提交 Runtime、Pod、主体或凭据选择：未采用，会绕过服务端主体和当前授权校验。

## 后果与验收边界

实现必须证明拒绝后当前 Turn 正常结束、同一会话的授权入口仍可用、授权后重试由新的合法
Execution 完成；原 Execution 不被恢复或延长。必须覆盖主体、Agent、Session、代次、停止/停用、
撤权和跨主体负例，并证明安装材料只在受保护 Host 边界供应。未知结果、失败或无法确认当前授权
时沿既有收口规则处理，不重放原业务操作。该决定不改变 Connection 的独立授权、审计、撤销和
凭据保护合同。
