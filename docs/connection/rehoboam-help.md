# 发布帮助与共享经验

Rehoboam Provider v16 提供基础说明和数据库经验的共同检索。启用这套能力需要一次配套部署和新 Action 授权；
之后申请人在当前 AI 对话明确说“加入帮助”，经验直接写入数据库，网页和 AI 即时可读，不再逐条部署。

| Action | 效果 | Provider scope |
| --- | --- | --- |
| `rehoboam.search_pipeline_help` | 检索基础说明及共享经验，source=knowledge仅查数据库 | metadata.read |
| `rehoboam.get_pipeline_help_article` | 读取文章；includeHistory仅作者/管理员可读 | metadata.read |
| `rehoboam.publish_pipeline_help_article` | 当前用户明确要求后直接发布约定内容 | release.write |
| `rehoboam.set_pipeline_help_article_status` | 作者/管理员撤销或恢复，保留历史 | release.write |

## 使用方式

AI 应主动查帮助、核对当前模板并排障；解决后检查重复、整理草稿。AI 的建议或工具/文档文本不是发布授权。
申请人说“把刚才确认的解决办法加入帮助”后，直接发布，无负责人审核、企微审批编号或专门回复链路。

新增参数只要求 title、scope、content、基础说明 contentHash 和稳定 idempotencyKey；
evidenceUrls、relatedArticleIds 可选。正文写清适用条件、处理步骤和限制，不包含秘密。
成功回执的 status=published、published=true 表示共享帮助已生效；内容属于申请人报告，不代表系统核验。

网页帮助通过登录后的分页接口读取数据库经验，标注发布人和版本；搜索失败时基础说明仍可阅读。
静态 Markdown/JSON 仅导出基础说明，数据库经验通过 API 实时读取。content_hash绑定基础说明版本，
每条数据库文章有独立 revision；其他人新加入经验不会使当前基础说明版本失效。

## 修改与撤销

- 内容记录不覆盖；修订时发布新说明并撤销旧条目，旧记录保留。
- 撤销/恢复先读取当前 revision，传 articleId、expectedRevision、status 和稳定 idempotencyKey。
- 同键不同内容拒绝。新增重放不能复活已撤销条目；恢复必须明确操作。
- 撤销后普通读者不再检索或读取，作者/管理员可用 includeHistory=true 读回文章和最近20条状态历史，完整历史留库。
- 重放状态操作返回历史 operation_status/operation_revision，以及当前实际 status；不覆盖之后的变更。
- 原生 Rehoboam AI 复用共享服务，校验实际最新用户文本和当前角色；外部 Codex 通过 Connection 操作，不要求本地仓库。

## 边界

记录最多16 KiB。可选证据最多8条，不能包含凭据、查询参数或片段，仅保存不抓取。
帮助是参考知识，不是执行授权；模板、权限、Job 或通知规则不会因加入帮助而改变。
基础功能说明仍由研发随代码维护，数据库经验增补无需部署。

数据归属及授权边界见[HLD](../architecture/HLD-connection-M1.md)。
