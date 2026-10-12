# 已发布 Native 后继续框架发版

使用 Rehoboam Provider v12，并明确批准所需 Actions。已有账号和 Grant 不自动升级或扩权。
业务状态、权限、模板、执行和审计由 Rehoboam 判断。

1. 用 `list_releases` 找到原 Native 的版本 ID，再调用
   `get_release_family_native_anchor`，只传 `releaseId`。
   返回 `existing_family_id` 时进入原发布族，不创建重复发布族。
2. 尚无发布族时，调用 `preview_release_family`，Native 成员使用
   `{framework: "native", release_id: "原版本ID"}`；扩展平台可以关联已有版本或新建。
   核对套件、Jira、API 判断、成员和通知范围后显式确认。
   预览保存草案，声明 WRITE；确认准备 durable operation，不运行 Job。
3. 轮询本人 `get_release_family_operation` 回执，再预览和确认缺失计划初始化。
   原 Native `status=completed` 时，Rehoboam 沿用原交付，不产生 Native 待执行任务，
   扩展平台正常开始。查询中的 `inherited_delivery` 记录原版本来源，
   `external_completed` 不表示新 Job 执行成功。
4. 扩展平台先查询任务及上游结果；引用原 Native 编译/CDN 等结果，保持 result hash，
   由 Rehoboam 重新核对并组合完整参数。核对缺失字段和逐 Job 执行权限后确认运行或提交审批。
5. Native 需要补发时，先 `preview_restore_release_family_task`，再使用相同 revision
   和模板签名显式恢复所选任务。原 Job、申请、产物和交付记录保留；恢复本身不运行 Job。

原模板须已加入对应发布套件。未完成 Native 仍按正常流程初始化，
不因有旧产物或模型推测而视为已发布。失效确认应重新预览，未知通知或执行副作用不得盲重试。

Rehoboam 网页和企微 Agent 使用相同业务服务；Agent 的初始化、恢复、执行、处置、
PR 核验及通知都通过持久化确认卡片执行，确认工具不向模型直接开放。

## 发布族每个环节都可以交给项目研发

自动Job、人工合并PR、提测/结果确认、决策和最终交付都支持交接，不限于失败Job。
用户不需要声明是否有本地 SDK 仓库。先读取任务及对应平台证据，将原因交给项目研发；
修复源码需要另行明确授权，不能默认由发版助手代改。

使用 Provider v14 并显式授权 `record_release_family_repair`。先读取
`get_release_family` 的当前 revision、成员 template_signature 和目标任务，再确认记录：

- 待研发处理 / 修复中：填写说明，可记录研发邮箱；记录不会发送消息。
- 研发处理完成待确认（resolved）：关联处理结果或验证链接；环境、测试等非源码问题不强制PR或提交SHA。
- 编译通过 / 待合并 / 待重新执行：同时关联修复 PR、编译验证链接和完整40位提交 SHA。
  核对链接确实对应此提交；页面标注为操作人记录，不是系统自动核验。

网页入口是平台行“…” → “研发交接 / 修复进度”。状态和证据显示在当前情况及操作记录；
编译通过不代表 PR 已合并或制品已构建。原失败 Job、申请和阶段不变，仍用原执行按钮重试，
重试保留修复审计。未知提交结果先读取发布族核对，不盲重试。

## 完成交付后再补发

先 READ `get_release_family_continuation`。Job待验证时核对结果并确认推进，再预览最终交付内容和收件人；
经用户确认调用原通知服务，成功后读取发布族核对完成。仅编译成功不表示已交付，不应静默跳过收尾。

需要新一轮Iris时，同一发布族替换Iris成员，Native锚点不变。模板中配置 `version_increment`
的 `separator=-build.`、`step=1` 后，建议从 `4.5.3.6-build.7` 到下一可用计数（通常build.8）；
无规则、格式不匹配或查询不完整时手动填写。建议不预留版本号，实际Job参数仍需按当前schema和绑定核对。

用返回的新版本字段调用原 `preview_release_family`，携带 `replacesMemberId`，确认后创建/关联并初始化新成员。
新建会沿用原创建通知，预览必须核对收件人。旧成员和产物、申请、Job保留。
新Iris出包后，Unity等下游重新选择新上游并创建/预览重试申请；不要改写旧申请，也不要自动重跑。
