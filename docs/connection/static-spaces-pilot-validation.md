# StaticSpaces pilot 发布后验收

本次范围以 [已批准 ADR](../adr/ADR-connection-static-spaces-supervised-pilot.md) 为准。
实现由 [#1686](https://github.com/AgoraIO-Extensions/agent-infra/issues/1686) 交付，发布后真实验收由
[#1687](https://github.com/AgoraIO-Extensions/agent-infra/issues/1687) 跟踪；本文件不是验收通过记录。

## 发布与连接

1. 当前代码 head 的全仓检查、CI 镜像、Issue/Review/Human 门禁通过并合并到 `connection`。
2. 使用正式上海 release 流程，绑定已合并 migration PR；核对迁移 receipt、版本和单写入实例。
3. 在既有 Connection 页面，以获准本人发起 StaticSpaces 公司连接申请；管理员配置七项受限
   Action 的能力包和审批策略，按原流程审批。不得手动修改生产 SQL 或借用其他账号。
4. 在正式 StaticSpaces Credential 表单提交现有 Token，不轮换或撤销；确认外部账号 `841`。
5. 选择 `consumer-codex`，预览并明确同意全部七项 `@v2` Action，核对 fixed shared scope、
   publish-space 的 ACL/组/Application 非原子效果、最长窗口与不覆盖约束。
6. 记录当前 Codex client 版本；在原 OAuth/MCP 入口验证 Consumer 身份与授权，不能使用旁路。

## MCP canary

只使用 ADR 的固定 run ID，路径为 `connection-onboarding/<run>/...`；每个文件正文包含
`connection-e2e:<run>`。所有 WRITE 显式设置 `kind=shared`、`slug=connection-test`、
`overwrite=false` 和独立、稳定的入站 idempotency key。禁止并行改变空间/ACL/组/Application。

- `get_current_user` 返回稳定账号 `841`；`list_files` 仅查询该空间。
- `publish_space` 仅新增本轮 Markdown；`upload_html` 仅新增本轮 HTML；
  `upload_static_package` 使用通过预检的 ZIP/tgz/tar.gz，所有归档文件均属于本轮且带 marker。
- `download_file` 对每个新增文件回读原始 bytes、size、SHA-256；`get_markdown_review` 回读该
  Markdown 原文和 API 返回的 review URL，不新增评论。
- 同 idempotency key 的重复成功调用不得再次外部写入。未知结果保留 `UNCERTAIN`，关闭本
  Provider 新准入且不自动重放，随后只读对账；不能再执行本轮其他 WRITE。
- 保留 call ID、Grant/ActionVersion、Effect/Dispatch 终态及安全上游 request ID；不得记录 Token、
  query/document正文或以网关 request ID 冒充外部效果证明。

## 清理与退出

通过获准上游清理接口逐项确认本轮路径、marker 与 SHA-256 后清理；回读远端文件列表。
不删除测试空间、组、ACL、Application，不新增 Connection 删除 Action，不触碰业务文件。
最后撤销本轮 Grant 或断开本轮 Connection，核对永久关闭记录。到期后新准入必须拒绝；
关闭不等于退休，保留登记执行器与审计，退出按既有版本依赖清理门禁处理。

证据只证明本次实际运行；未完成事项继续开放，不能转为广泛生产认证或 v1 `LIVE_VERIFIED`。
