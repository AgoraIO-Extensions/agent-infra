# 文件存储部署与验收

文件权威与授权以[工程 Spec §15.4](SPEC-agent-infra-M1-engineering-architecture.md#154-文件)为准；本页说明装配和操作，不改变产品保留政策。

## 装配

Platform API 的 `PlatformApiAssemblyInput.files` 接收部署创建的 ObjectStorage Adapter、文件签名密钥、原 Execution Grant 验签公钥、服务身份到允许 Agent 的映射，以及当前用户与文件限制查询。缺失此配置时不注册文件入口，带附件的 Message 被拒绝。

使用 `createS3ObjectStorageV1` 创建 S3 Adapter。bucket 必须启用 versioning，并支持条件创建、按版本读取、版本列举及删除。部署独占一个前缀；所有对象引用均由平台生成。endpoint、region、bucket、prefix、凭证和 SDK 只在 Adapter／部署模块内配置。生产凭证通过部署凭证供应链提供，不写入仓库。

文件数据面只接受平台路径和 `X-Platform-File-Grant` Header。浏览器同时携带当前会话；Worker 同时携带服务身份。S3 签名地址仅用于平台内部上传，不返回给用户或 Runtime。

`readLimits` 按当前 Agent configuration revision 和 Channel 返回 Agent、Channel、deployment 三方声明；平台再次检查已验证 capability，取支持类型与大小的交集。声明需要版本和有效期，缺失或过期拒绝。S3 Adapter 对实际内容探测类型、计数并计算 SHA-256；支持的声明必须与部署选择的可验证格式一致。普通历史读取不以 Agent 运行状态或新的执行输入限制为前提。

## Worker 与恢复

`createWorkerFileClientV1` 提供输入读取与结果写入。它使用原始 Execution Grant 调用交换入口，随后携带文件 Grant 与服务身份传输字节；不接受调用者指定的对象键或存储地址。实际 Driver 文件桥接不属于本模块。

结果写入的 `idempotencyKey` 标识永久不变的写入意图。访问到期后，调用者可传入新的 `accessIdempotencyKey` 换取该意图的新临时权限；不要换一个意图键重试同一结果。已确认对象只允许重放完成确认，不能重新上传或覆盖字节。执行终态、撤权或代次变化仍拒绝执行授权。

部署在 `PlatformWorkloadWorkerOptionsV1.files` 提供清理配置后，现有 Worker 轮询同时执行文件对账并在停止时关闭其 Store。独立调度也可调用 `createPlatformFileReconciliationWorkerV1(...).runOnce()`，并在退出时调用 `close()`。单次最多处理 `batchSize` 个过期意图及一个不超过同一大小的对象版本页，`batchSize` 为 1–100。数据库保存扫描游标，协调锁避免多 Worker 同时推进；失败页保持游标供重试。`orphanGraceMs` 由部署政策设置，避免过早处理新对象。

协调器标记过期未完成上传，按确切对象版本删除孤立、失败、过期或已标记删除的对象，保留文件记录防止引用复用。迟到写入在后续扫描中再次清理。已确认历史文件不因 Agent 停止、升级、重启、停用或执行结束被清理。正式历史的保留由部署政策负责，本模块没有用户删除或会话导出接口。

## 验收

使用仓库固定的 Node／pnpm 工具链。完整 `pnpm test` 包含文件的真实 HTTP／PostgreSQL／MinIO 验收；单独执行 `pnpm test:file-authority` 前需构建 workspace 依赖。

测试创建随机命名、仅绑定 loopback 的独立容器，并仅回收这些容器。Fake 与 S3 使用同一对象契约，测试覆盖版本固定、重放、并发、过期、对象缺失、冲突及重复清理。平台联测覆盖上传、下载、结果写入、同入口跨用户拒绝、撤权与旧代次拒绝。

发布验收记录只保留 source commit、配置版本、对象存储实现／镜像 digest、测试命令和结果。禁止记录文件正文、服务凭证、JWS 或内部签名 URL。测试通过不替代后续文件消费者整装与人工验收。
