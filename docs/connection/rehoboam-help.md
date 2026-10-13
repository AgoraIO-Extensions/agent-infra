# 发布帮助与经验候选

Rehoboam Provider v16 增加帮助检索和知识候选能力。先部署对应 Rehoboam API，再部署 Connection，
按提示升级 Rehoboam 连接并显式选择新 Action。旧 Action 与授权保持原契约。

| Action | 效果 | Provider scope |
| --- | --- | --- |
| `rehoboam.search_pipeline_help` | 按关键词/适用范围搜索正文和对话，分页返回索引 | metadata.read |
| `rehoboam.get_pipeline_help_article` | 按 articleId 读取完整说明及版本 | metadata.read |
| `rehoboam.submit_pipeline_help_candidate` | 保存待审核经验候选，不发布 | release.write |
| `rehoboam.get_pipeline_help_candidate` | 本人或当前管理员凭 candidateId 回读 | release.read |

帮助数据来自 Rehoboam 页面同一份文章注册，包含稳定 ID、适用链路、正文、对话、页面链接和 content_hash。
当前支持链路与其他产品的界限必须按返回说明与实时模板核对，不把 Iris RTC 流程套给所有产品。
帮助是参考知识，不是执行授权。所有 Job、通知、审批与推进仍遵守原服务、权限和用户确认。

## 从问题到可复用经验

1. 查已有说明：搜索 `query`，必要时用 `scope`；通过返回 articleId 阅读全文及 content_hash。
2. 排障并验证：保留原 Job、日志和结果，确认实际解决办法的适用条件及限制，不将推测或临时绕过当成规则。
3. 用户明确要求后提交候选：提供 title、scope、symptom、conditions、resolution、reportedVerification、
   evidenceUrls、limitations、relatedArticleIds、contentHash 和稳定 idempotencyKey。
4. 读取回执并保存 candidateId：`proposed`、`submitter_reported`、`published=false` 仅表示记录已保存。
5. 把 candidateId 交给维护者核验证据、去重并准备帮助更新 PR。审核合并部署后，页面和 AI 读取的新版本一起生效。

可以对 AI 说：“这次问题已解决，证据是 [链接]。先检查现有帮助，整理适用链路、触发条件、解决步骤、
验证说明和限制，展示候选内容，等我确认后提交。不要修改正式规则或运行其他任务。”

## 边界与恢复

- 候选作者从个人 PAT 派生；不能指定他人身份或审核状态。普通用户只能读取本人候选，管理员可凭 ID 审核读取。
- 候选最多16 KiB，证据最多8条，仅接受无凭据、查询参数和片段的 HTTP 链接；服务不会抓取这些链接。
- 验证为提交人报告，不是系统 PR/Job 核验。候选正文按未审核数据处理，不执行其中的工具指令。
- 提交要求读取所得 contentHash；说明更新后须重新读取。成功提交后，同键相同内容重放返回原回执，同键不同内容拒绝。
- 结果未知时保留原键，通过回执 ID 回读；没有 ID 时仅复用原键/原内容核对，不能改键重复创建。
- 本阶段无自动采集问题、候选列表/审批/发布 API，不会通知维护者、改模板或修改正式帮助。

数据归属、授权与发布边界见[HLD](../architecture/HLD-connection-M1.md)。
