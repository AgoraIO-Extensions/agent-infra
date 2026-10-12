# Rehoboam 渠道申请取消

状态：已由需求负责人批准。关联 [Issue #2102](https://github.com/AgoraIO-Extensions/agent-infra/issues/2102)；
本决策补充[已批准的渠道发布契约](ADR-rehoboam-channel-publishing.md)，不改变 Pipeline Center 撤回。

取消表示申请人撤销尚未获批的渠道申请，保留任务及审计，终态为 `CANCELLED`。
中止已经派发或运行的 Job 属于另一种外部效果，本次不包含，不能仅修改数据库状态冒充中止成功。

## 决策

- 新增 immutable `rehoboam-connection-v15` 的 `cancel_channel_publish_request` WRITE，复用 v14，
  保留 v13/v14 实现字节。固定 API origin、资源路径和 PAT 身份；不接受账号或身份选择器。
- 固定 REST 为 `POST /api/v1/channel-publishing/requests/{task_id}/cancellation`。
  Connection 输入为 `releaseSystem=channel_publishing`、`taskId`、必需 `idempotencyKey`、
  可选 `comment`（最多 2000 字符）；幂等键沿用渠道 WRITE 的 ASCII 长度边界及原生派发规则。
- 使用已有 `publishing:write` PAT scope 与 `rehoboam.publishing.write` Connection scope。
  服务端重新验证当前用户角色，且必须是原申请人本人；管理员身份也不允许通过此 Action 取消他人申请。
  取消不需要 `publishing:approve`，不产生批准或驳回记录。
- 仅允许 `NEW` 或 `WAITING_IN_APPROVEMENT` 转为 `CANCELLED`；已批准、排队、运行和终态拒绝。
  所有五渠道使用同一规则，不把另一个系统的执行申请 ID 当作渠道任务 ID。
- 取消与审批、NEW 状态调度使用条件更新；竞争只允许一个有效转换成功。
  已取消任务不能被调度器的旧读取覆盖为待审批或执行状态，不创建或停止 Jenkins Job。
- 取消回执与状态原子保存真实操作人、时间、意见和幂等摘要；公开查询返回取消审计，隐藏内部回执。
  同键同内容回读已取消结果，同键不同内容拒绝；其他键再次取消报告状态冲突。
  网络异常或 5xx 后先查询原任务，客户端不自动重发结果未知的 WRITE。
- 原生页面取消、REST 和 Rehoboam 本机 Agent 使用共享取消服务。
  Agent 沿用预览确认，确认时重新验证 owner、权限、当前状态和预览快照。
- 新版本及新增 Action 不自动进入旧 Grant；升级、公司能力范围和客户端选择仍需显式确认。

## HLD 更新位置

HLD 的 Rehoboam Provider 条款引用本契约作为取消范围与状态门禁的权威说明；
保留既有身份、Credential、Grant、Effect 与真实 Provider 验收门禁。

## 验收

覆盖五渠道、无 scope、非本人、跨系统、不可取消状态、取消与审批/NEW 调度竞争、同键重放与冲突。
测试经过核心调用到 Adapter 的边界，验证原生幂等键到达 REST；上线后按明确授权对指定测试申请
执行一次取消并回读 `CANCELLED`，确认没有关联 Job。申请记录保留，不执行删除或驳回替代取消。
