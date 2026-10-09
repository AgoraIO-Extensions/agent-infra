# Rehoboam 版本与配置管理

`rehoboam-connection-v11` 增加 28 个 Actions，保留 v10 的 42 个能力。
Rehoboam 后端必须先部署；Connection 升级要求重新审批和显式选择新增能力，不自动扩大旧授权。

| 对象 | 新增能力 | 权限 |
| --- | --- | --- |
| 版本 | 编辑预览/确认、复制预览/确认、时间线 | release:read/write |
| 模板 | 完整配置读取、创建/编辑/复制预览与确认 | metadata:read 或 release:write；管理员 |
| 流水线定义 | 列表、完整配置读取、创建/编辑/复制预览与确认 | metadata:read 或 release:write；完整配置及写入要求管理员 |
| 客户配置、Native 发布标记 | 列表及脱敏详情 | metadata:read |
| 执行申请 | 编辑并重新提交的预览/确认、时间线 | release:read/write；申请创建者或当前审批者按操作校验 |
| 操作 | 本人预览/提交结果回查 | release:read |

写入均分为 preview 和 confirm。外层参数使用 camelCase，`changes` 和 `configuration`
使用配置读取返回的 snake_case 字段。预览展示前后值和副作用；确认只提交 previewId、confirmationToken
和本次确认的 idempotencyKey。预览与确认使用不同的 key，同一 Action 的重试复用原 key。

例如编辑 RN RTM 版本：先调用 `rehoboam.preview_update_release`，传 releaseId 和
`changes: {title: "【RN RTM】2.3.1", version: "2.3.1", target_branch: "dev/2.3.1"}`，
核对差异后调用 `rehoboam.update_release`。这里只改版本记录的分支字段；Git 分支重命名需单独在仓库执行。

版本复制要求显式提供新标题、版本、Jira、基线和目标分支，不复制历史 Job、审批、通知或测试记录。
模板/流水线复制遇到被隐藏的敏感配置时要求显式替换，不能默默丢弃凭据后生成错误配置。
模板卡片承载分支、参数及流水线绑定；配置写入不启动 Job，也不发送发布通知。
执行申请编辑仅允许创建者修改 rejected/withdrawn 申请，重新计算当前审批人并恢复原通知/调度流程，
不会直接运行 Job。

Rehoboam 保存 owner、十分钟确认期限、token hash、资源和引用快照。确认重验权限及快照，
以 CAS 和资源 reservation 防止重复提交。原生写入持久化 effect 回执；响应丢失时用
`rehoboam.get_release_operation` 回查。未完成或未知结果保留 reservation，禁止通过新预览盲目重发。
回查是纯 READ，不清理锁或修改业务数据。预约只串行化 Connection 写入，旧网页并发修改由原生 CAS 检测。

仅接受固定资源与字段、批准的 CI/仓库地址，不接受调用方身份、任意 URL/Header 或明文凭据。
密码参数值及默认值不返回、不持久化到预览。删除、凭据管理和账号权限管理未开放。

边界及发布门禁见 [HLD](../architecture/HLD-connection-M1.md) 与
[AI 发版入口决策](../adr/ADR-connection-primary-rehoboam-ai-release.md)。
