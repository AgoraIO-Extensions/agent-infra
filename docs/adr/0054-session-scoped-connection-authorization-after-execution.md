# ADR-0054：Execution 结束后保留会话级 Connection 授权入口

## 状态

提案，归属 [#4480](https://github.com/AgoraIO-Extensions/agent-infra/issues/4480)。Platform 产品结论
以 [PRD §9.1](../prd/PRD-agent-platform-M1.md#91-owner-按需关联与用户-oauth) 为准，完整技术合同
以[工程 Spec §§13.5.6–13.5.7](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1356-标准-oauth-安装供应)
为准；本 ADR 只记录授权边界取舍和新增的受信投递路径。

## 背景

旧安装入口把授权命令绑定到仍在处理的业务 Execution。Connection 调用被拒绝后，使用者无法在
原会话完成授权并重试，导致一次已经结束的业务处理错误地成为授权前置条件。用户决定不挂起或延长
Turn，保留会话授权入口，并在授权后允许同一会话重试。

## 决策

- 会话级授权入口和授权后可用时机由 PRD §9.1 定义；授权命令的字段、期限、隔离和失败语义由
  工程 Spec §13.5.6–§13.5.7 定义。
- 新增 `ConnectionInstallationDeliveryGrantV1` 作为控制用途同类的安装交付授权。它固定原用户、
  Agent、Session、代次、Pod UID、fence、安装修订、命令摘要和期限，复用既有受保护 Worker→Host
  命令通道，不依赖业务 Execution、业务 outbox 或新队列。它只允许安装准备、回读、确认和换码，
  不承载模型、工具、业务写入、ACK 或 Turn。
- 该授权的 `expiresAt` 取 Platform 授权记录的 `expiresAt`，并取 Connection 授权请求有效期的较早值；后续 Execution 不能刷新 state、授权码或期限。凭据只在后续
  合法 Execution 的 reader 中使用，Host 仍须确认认证主体等于原用户、Agent 和 Session。
- Connection 继续独立负责主体、Consumer、Instance、Grant、外部授权、凭据保管和撤销；不新增
  身份或凭证服务，不把 Platform 变成 Connection 代理。

## 备选

- 挂起原 Turn 直到用户完成授权：未采用，会延长业务 Turn 并保留不应继续占用的执行位置。
- 一律等下一次业务 Execution 才投递授权命令：未采用，无法在授权请求的有效期内完成 confirm 和换码，
  也会把用户操作错误地绑定到下一次业务重试。
- 强制新建会话后再授权：未采用，会丢失使用者当前会话的连续性。
- 让调用方提交 Runtime、Pod、主体或凭据选择：未采用，会绕过服务端主体和当前授权校验。

## 后果与验收边界

实现验收以 PRD 与工程 Spec 的合同为准，至少覆盖：同一会话拒绝后授权并重试、固定期限和 state
不刷新、跨用户/Agent/Conversation/Consumer/ConsumerInstance 拒绝、API/application 凭据拒绝、
停止/停用/代次隔离、绑定漂移、fence 错配、结果不明和跨主体负例。原业务 Execution 不被恢复或
延长，安装投递失败不改变业务结果，不重放未知命令；安装材料仍只在受保护 Host 边界交付和使用。
