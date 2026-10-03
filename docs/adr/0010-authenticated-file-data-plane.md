# 认证文件数据面与独立执行期文件授权

S3 预签名 URL 的持有者可以直接访问对象，不能单独满足平台每次访问时的主体校验与撤权要求。M1 文件访问统一经过 Platform 的认证流式数据面；S3 兼容 Adapter 复用官方 SDK，预签名只作为服务器内部能力。执行结果写入采用独立、对象级 `FileAccessGrantV1`，由可信 Worker 请求 Platform API，经文件 Core 分配和授权后在平台可信边界签发，保留现有 Execution Grant 的只读附件含义。

## Considered Options

- 向浏览器或 Runtime 返回 S3 bearer URL：无法在使用时核验当前平台主体、撤权和执行代次，因此不采用。
- 在旧 Execution Grant 附件操作中直接加入 `write`：结果对象尚未由 Platform 分配，且会改变旧消费者的安全语义，因此不采用。
- 由各 Runtime Driver 管理存储和凭证：会复制对象权限与生命周期，并扩大 Runtime 权限，因此不采用。

## Consequences

Platform API 承担有界流式传输，需要部署并发、大小和超时限制。每次访问依赖当前授权和元数据可用性，依赖未知时 fail closed；授权后已发生的对象写入由原意图对账，不虚报文件可用。Schema、签发方、消费方、恢复与清理的唯一工程定义见 [工程 Spec 文件条款](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#154-文件)。
