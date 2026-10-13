# 发布帮助与共享经验

Rehoboam Provider v16 提供基础说明和数据库经验的共同检索。启用这套能力需要一次配套部署和新 Action 授权；
之后申请人在当前 AI 对话明确说“加入帮助”，经验直接写入数据库，网页和 AI 即时可读，不再逐条部署。

| Action | 效果 | Provider scope |
| --- | --- | --- |
| `rehoboam.search_pipeline_help` | 检索基础说明及共享经验，source=knowledge仅查数据库 | metadata.read |
| `rehoboam.get_pipeline_help_article` | 读取文章；includeHistory仅作者/管理员可读 | metadata.read |
| `rehoboam.publish_pipeline_help_article` | 当前用户明确要求后直接发布约定内容 | release.write |
| `rehoboam.set_pipeline_help_article_status` | 作者/管理员撤销或恢复，保留历史 | release.write |
| `rehoboam.update_pipeline_help_example`（v17） | 管理员确认后原地修改数据库对话示例，保留完整修订历史 | release.write |

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

47 个核心对话示例保存在 Rehoboam 数据库，旧分享 ID 保留。网页管理员可以在文章内
“编辑示例 / 修订历史”修改；AI 先读取最新 revision、展示完整草稿，管理员明确确认后使用 v17
update_pipeline_help_example。传 articleId、expectedRevision、fields 和稳定 idempotencyKey；
fields 包含 title、category、scope、text、guidance、followup、confirmation、outcome 八个文本字段。
保存后网页/AI立即读到新版，无需重新部署；修改不变更模板或 Job。非管理员只能准备草稿，不能越权修改。
冲突先重读，不自动覆盖；未知结果读回或复用原键，不能换键盲重试。
旧操作重放可返回较新的当前正文，operation_revision 标识本次历史操作，不把旧回执当最新状态。

管理员首次显式初始化仅补缺失示例，不覆盖已编辑内容；启动/读取不会初始化。
这个入口在 Rehoboam，不是 Connection 的自动初始化 Action。v16 保留原字节和旧授权；
升级到 v17 时明确选择并授权新增修改能力。静态导出仍只包含基础功能说明。

- 普通经验正文记录不覆盖；修订时发布新说明并撤销旧条目，旧记录保留；数据库核心对话示例按上面的原地编辑流程维护。
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
