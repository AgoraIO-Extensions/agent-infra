# ADR: 能力包跟随连接器当前版本

## 状态

已由用户批准设计边界，实施由 [#1902](https://github.com/AgoraIO-Extensions/agent-infra/issues/1902) 跟踪。

## 决策

按 [Connection PRD](../prd/PRD-connection-M1.md) 的能力包升级行为和
[HLD 16.7](../architecture/HLD-connection-M1.md#167-connection-access-approval) 实现新申请目录跟随。
复用精确兼容证明、不可变能力包和策略修订、站内 outbox，不建立另一套用户授权机制。
受信 Catalog 装配负责自动对账，浏览器不能提供兼容声明。管理员确认通过既有修订接口完成，
所有历史批准继续使用原版本来源。

## 取舍

权限兼容证明不足时宁可等待管理员，不按版本号或能力名称猜测兼容。新增能力作为可选更新，
不阻塞原能力兼容跟随，也不自动纳入 full 能力包。首次启动、重复启动和并发编辑均按来源
revision 与当前目标收敛；部署不自动替员工申请、审批或扩大 Consumer Grant。

自动对账不使用管理员身份。新增版本化迁移为审计记录引入受限的 `SYSTEM` 主体，只允许能力包
跟随及对应策略发布事件使用空 Principal；普通审计仍必须绑定真实 Principal。回滚保留追加
schema，仅回滚兼容镜像，不恢复历史审批或用户权限。
