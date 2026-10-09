# ProviderRelease 弃用与下线

旧版本承载已确认的能力契约、账号和授权，不能仅因为已有新版本就删除执行器。
生命周期使用现有 PUBLISHED/DISABLED 状态和独立弃用/下线时间戳，保留不可变目录与历史记录。

管理员通过 `GET /api/v1/connection/admin/provider-releases/{releaseId}/lifecycle`
读取 revision、接替版本及账号、Grant、当前声明、未完成调用四类依赖数量。接口不返回凭据或调用正文。

同一路径 POST 接受以下操作，要求管理员浏览器会话、同源请求、Idempotency-Key 和当前 `If-Match: "revision"`：

- `{"operation":"deprecate","successorReleaseId":"new-release","reason":"新版本已就绪"}`：接替版本必须是同 Provider 当前运行版本且未弃用。当前运行版本不能弃用。
- `{"operation":"retire","reason":"迁移已完成"}`：要求已经弃用且四类依赖全部为零，事务内重新检查后禁用。

弃用版本继续执行已有授权，但不再接受新账号、新 Grant 或新声明。已有账号通过原升级/重新授权流程迁移；
沿用既有兼容证据、审批和用户选项，不自动扩大权限。旧声明需由其 Consumer 发布新声明或撤销。
过期但仍标记 ACTIVE 的 Grant 也阻止下线，必须通过原撤销/迁移流程处理。

未完成调用包括 AUTHORIZED/UNCERTAIN，以及关联的 PREPARED/UNCERTAIN Effect 或
PENDING/SUBMISSION_STARTED/UNCERTAIN Dispatch。即使 Call 已终止，只要关联效果仍未完成也不能移除执行器。
数据库准入触发器持有版本共享锁；下线持有排他锁，使并发新增依赖不能绕过最后一次检查。

先部署本机制，让启动过程记录现有运行路由；之后每次启动检查已记录版本和实际依赖。
机制接入前就没有路由的未登记旧版本作为历史欠账报告，不阻止首次接入，也不自动选择其他版本的执行器。
已登记且尚未下线的执行器缺失会阻止启动；已登记版本有未完成效果时也不能移除。
历史欠账的依赖仍阻止退休，必须独立迁移或对账；首次登记不会修改账号、Grant 或 Call。
下线成功后，下一次代码发布才可移除其路由；
仍被新版本委托使用的源代码也必须保留，不能只根据数据库下线状态删除文件。
历史 ProviderRelease、ActionVersion、Call、Effect 和审计不删除。

已有升级活动可显示迁移进度，但其活跃 Grant 数量不能替代本依赖报告。
若结果未知，先回读生命周期及 revision；同一次 POST 重试复用原 Idempotency-Key。
实施本机制不会自动弃用或下线任何生产版本。
