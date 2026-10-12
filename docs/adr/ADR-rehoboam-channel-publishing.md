# Rehoboam 渠道发布 Provider

状态：已由需求负责人批准。关联 [Issue #1986](https://github.com/AgoraIO-Extensions/agent-infra/issues/1986)
及 [EEP-1833](https://jira.agoralab.co/browse/EEP-1833)。实现及发布仍需通过仓库验证和真实 Provider 验收。

## 背景

Rehoboam 的 Publishing 与 Pipeline Center 是两套发布系统；后者也可以运行 Maven/CDN Job。
渠道名、版本号或“发版”本身不能确定目标系统。当前 v12 只覆盖 Pipeline Center 及发布族。

## 决策

- 以新的 immutable `rehoboam-connection-v13` 增补 `channel_publishing` 能力，保留 v12 及更早源码和路由。
- 新增 `list_channel_publish_requests`、`get_channel_publish_request`、
  `get_channel_publish_options` READ，以及 `create_channel_publish_request`、
  `approve_channel_publish_request`、`reject_channel_publish_request` WRITE。
- 五个渠道为 CDN、Maven、CocoaPods、SwiftPM、NPM。CDN 多文件以逐文件独立任务提交，
  每项独立幂等键及回执；部分成功必须明确，不以一个批次成功掩盖失败。
- 固定 `/api/v1/channel-publishing` 路径和原有 API origin；业务规则、配置、审批人与状态
  真值属于 Rehoboam。不得接受 URL、Header、凭证、申请人或审批人选择器。
- 新 Actions 返回 `release_system=channel_publishing`；v13 中旧业务 Action 描述明确
  `pipeline_center`。任务 ID 不跨系统复用；写操作必须有明确系统、目标和参数。
- 用户意图不明确时先澄清；有明确双系统查询意图时可分别查询并标明来源。
  不能仅凭 Maven/CDN 渠道名猜测，也不能按两个系统同时执行写操作。
- PAT 新增独立 `publishing:read`、`publishing:write`、`publishing:approve`，
  分别映射 `rehoboam.publishing.read/write/approve`。审批权限不由旧 release WRITE 隐含获得。
  Rehoboam 实时验证 PAT owner 角色及当前渠道配置中的审批资格；approve 隐含本系统读取。
- 所有 WRITE 必需 `idempotencyKey`；申请唯一索引复用原任务机制。
  审批在原任务文档中以待审批状态 CAS 同时写入真实审批人、时间、意见、决策和幂等回执。
  相同请求回读原结果；相同键不同参数或已经被其他请求处理返回冲突。
- 原调度器负责审批后的执行；API 不直接调用 Jenkins。网络超时或 5xx 后以任务 ID
  查询最终审批及运行状态，不自动重发可能已提交的 WRITE。
- Rehoboam Web、REST 与本机 Agent 使用同一审批服务和 CAS；Agent 写入沿用预览确认框架。
- 新账号版本及新增 Action 不自动进入旧 Grant；显式升级、批准和授权后方可执行。
  发布前完成 HLD 13.4 验收；生产 WRITE 联调必须有明确目标与副作用授权。

## 影响

保留两套发布流程及各自任务模型，用户可从工具名称、描述、预览与结果识别来源。
新增审批 scope 要求重新签发具备该 scope 的 PAT，再显式更新 Connection 账号及授权。
无法把旧发布族/执行申请 ID 当成渠道发布任务 ID，也不迁移或改写旧任务历史。

HLD 的 Rehoboam Provider 条款记录 v13 边界；该批准不替代发布和生产写操作授权。
