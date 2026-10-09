# 通过 Connection 创建 Rehoboam 独立版本

适用于普通模板（例如 RN RTM）；不要求 Native 发布族。创建仅生成待开始版本，不启动构建、发布、通知或 Jira 流转。

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
结果不确定时以原预览确认查询 Rehoboam 已完成回执或人工对账，禁止重新提交创建。
Connection 的既有 UNCERTAIN Call 不会因用户重试自动重新 dispatch；回执查询必须作为独立的受监督确认调用，
仍使用同一预览 ID/token，不生成新预览。

部署顺序为 Rehoboam 接口、真实 READ 验证、Connection Provider 发布，再进行用户升级/授权。
生产 WRITE 验收需要单独确认具名测试模板、版本字段和清理范围；本地测试不代表生产验证完成。

权限、版本和发布门禁以 [Connection HLD](../architecture/HLD-connection-M1.md) 为准。
