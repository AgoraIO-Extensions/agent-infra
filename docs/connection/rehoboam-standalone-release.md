# 通过 Connection 创建 Rehoboam 独立版本

适用于普通模板（例如 RN RTM）；不要求 Native 发布族。创建仅生成待开始版本，不启动构建、发布、通知或 Jira 流转。后续通知操作需另行预览并明确确认。

## 授权

升级到 `rehoboam-connection-v10` 后明确勾选新增 Actions。模板发现使用 metadata READ；
创建预览和确认使用 release WRITE，Rehoboam PAT 必须具备 `release:write`。
既有 Action 选择不自动扩展，新能力需重新授权。

## 操作顺序

1. `rehoboam.list_templates` 按模板名称分页查询，再用 `rehoboam.get_template` 核对模板 ID 与流程。
2. 调用 `rehoboam.preview_create_release`，提交模板 ID、标题、版本号、Jira、基线版本/分支和目标分支。
   WRITE 必须提供稳定的 `idempotencyKey`；预览保存草案，不创建版本。
3. 展示返回的规范化字段、重复版本提示和通知配置，等待用户明确确认。不要自行选择 Jira 建议版本号。
4. 调用 `rehoboam.create_release`，仅提交返回的 `previewId`、`confirmationToken` 和本次确认的稳定 `idempotencyKey`。
   snake_case 返回字段 `preview_id`、`confirmation_token` 对应上述 Action 输入；不要再次传版本字段。
5. 用返回的 `release_id` 调用 `rehoboam.get_release` 回读，并向用户报告待开始状态。

确认凭据 10 分钟内有效；字段或模板变化需要重新预览。确认不得跨用户使用。
同一次请求的响应丢失、传输重试和用户重试必须保留原 `idempotencyKey`，不能换键重新创建。
预览和确认是不同的 Action，必须使用不同的幂等键，例如 `release-preview-1` 与 `release-confirm-1`。
幂等键按用户、Consumer 和 Actor 去重，不按 Action 分隔；跨 Action 复用同一键应返回
`IDEMPOTENCY_CONFLICT`，同一 Action 的重试仍复用原键。
结果不确定时以原预览确认查询 Rehoboam 已完成回执或人工对账，禁止重新提交创建。
Connection 的既有 UNCERTAIN Call 不会因用户重试自动重新 dispatch；回执查询必须作为独立的受监督确认调用，
仍使用同一预览 ID/token，不生成新预览。

部署顺序为 Rehoboam 接口、真实 READ 验证、Connection Provider 发布，再进行用户升级/授权。
生产 WRITE 验收需要单独确认具名测试模板、版本字段和清理范围；本地测试不代表生产验证完成。

权限、版本和发布门禁以 [Connection HLD](../architecture/HLD-connection-M1.md) 为准。

## 独立版本提测、交付与测试通过

这三类操作复用 Rehoboam 原服务，会发邮件/企微并更新相应业务记录，不是只保存草稿。
已有的 `prepare_release_pipeline_run` / `execute_release_pipeline` 继续负责该版本的构建及发布 Job，通知操作不启动 Job。

1. 用 `rehoboam.get_release_notice_form` 提交 `releaseId` 与 `kind`，获取当前 Jira 表单。
   `kind=test` 为提测，`release` 为交付，`test_success` 为测试通过；测试通过不修改 Jira。
2. 用 `rehoboam.preview_release_notice` 提交 `releaseId`、`kind`、最终 `content` 和稳定的 `idempotencyKey`。
   可选 `jiraTransitionSubmission` 仅接受当前表单的 `mode`、`transitionId`、`targetStatus` 与 `fields`。
   把用户确认过的字段填入；不得擅自采用 Jira 默认值、切换目标状态或省略必填项。
3. 展示返回的正文、邮件收件人/抄送、企微渠道及提醒对象、Jira 评论/流转与状态影响，等待明确确认。
   提测可以不选 Jira 操作；交付始终添加 Jira 评论，所选流转才改变 Jira 状态，并把版本标记为完成；
   测试通过把测试进度设为100并发送原服务通知。
4. 用 `rehoboam.submit_release_notice` 提交 `releaseId`、返回的 `previewId` / `confirmationToken` 和本次确认的稳定 `idempotencyKey`。
   确认不能再传正文、收件人、Jira 字段或操作者。
5. 用 `rehoboam.get_release_notice_operation` 提交 `releaseId` / `previewId` 回读本人回执。
   `get_release` 同时提供提测、测试通过的记录总数和最新有界内容；内容截断会显式标记。

预览保存10分钟确认记录，不发消息、不改 Jira 或版本状态。确认前版本、模板、收件人或 Jira 表单变化时须重新预览。
同一确认重放只返回原回执。服务可能先更新 Jira/记录再发送邮件，失败或响应丢失后不可从新预览或另一通知类型绕过重发限制。
每版本 reservation 只串行化 Connection 通知；旧 Web/企微入口仍可能并发修改业务数据，证据不一致时按 uncertain 处理。
待核对的 reservation 不自动到期释放，需要人工检查版本、Jira 和通知结果后处理，不能使用普通版本更新或直接 DB 改写绕过。
回执的 `native_service_succeeded` 只表示原服务报告业务成功；`channel_delivery_verified=false` 表示未独立证明所有邮件/企微渠道送达。
