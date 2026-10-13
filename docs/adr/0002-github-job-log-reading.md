# GitHub Actions Job 日志读取

Connection Owner 于 2026-10-13 批准
[Issue #2274 的批准记录](https://github.com/AgoraIO-Extensions/agent-infra/issues/2274#issuecomment-6143087592)。
GitHub 日志下载需要跨 origin，且原始日志可能进入模型上下文；只允许以下具名范围，
不把 Jenkins 的日志例外扩展为通用下载权限。

## 决策

- 新的不可变 GitHub OAuth Provider v11 增加 READ `github.get_workflow_job_logs`，
  scope 为 `repo`。固定 API 路径为 `/repos/{owner}/{repo}/actions/jobs/{jobId}/logs`；
  调用方仅提交资源 ID 和行分页参数，不提供 URL、Header、Credential 或账号选择器。
- 仅接受 API 返回的一次 HTTPS 下载跳转，hostname 必须匹配
  `^productionresultssa[0-9]+\.blob\.core\.windows\.net$`，端口只能是默认 443，
  不允许 userinfo、fragment 或下载端再次跳转。不放行整个 Azure Blob 域名。
  每个下载连接复用 DNS/IP pinning、TLS hostname 校验和上海 GitHub 代理优先规则；
  只在代理明确不可用且目标请求尚未提交时回退受控直连。
- Bearer 只发送到 `api.github.com`。下载请求不携带账号凭据；临时签名 URL 不返回、
  不写入日志或审计，不缓存或持久化。HTTP 拒绝、超时和传输异常使用固定安全错误，
  不转发 Provider 错误正文。
- 原始构建日志不做额外内容脱敏，可以进入该用户已授权 Consumer/模型上下文及既有调用
  结果保留边界。GitHub masking 不保证业务敏感信息全部被移除；Owner 接受此残余风险。
  该批准不允许 Connection 原始 Credential、签名链接或普通诊断日志泄露。
- `startLine` 从 1 开始，`maxLines` 默认 200、上限 1000；单页正文最多 64 KiB。
  每次从头扫描最多 8 MiB、总请求/读取上限 30 秒；明确区分分页继续、正文截断与扫描上限。
  超长单行按完整 UTF-8 字符返回前缀，报告截断并推进到下一行；扫描上限以外不提供伪游标。
  日志为空、未就绪、已删除或已过期不能据此推断 Job 执行成功；403/404 保留 HTTP 状态，
  不依据 404 猜测仓库是否存在。
- v10 和旧版本源码及执行路由保留。v9/v10→v11 的原 143 项能力通过精确摘要证明保持等价，
  保留原选择与批准上限；新增日志 Action 需单独确认，旧 Grant 不扩权。
  GitHub 仍遵循现有 OAuth 重授权入口和 HLD 30.0 的兼容校验。

## 验收与限制

按 [HLD 13.4](../architecture/HLD-connection-M1.md#134-provider-onboarding) 验证新版本。
下载 hostname 不匹配、DNS/IP/TLS 校验失败或再次跳转均拒绝，不自动放宽。
旧 Action 委托不可变 v10 实现；测试必须覆盖下载凭证隔离、分页/截断、授权隔离与旧版回归。
实现和本地真实 READ 不等于发布、部署或 Consumer 已获得新增授权。
