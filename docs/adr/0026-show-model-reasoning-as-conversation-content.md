# ADR-0026：思考过程作为会话正文保存与展示

## 状态

已采纳。产品方向由 [#2976](https://github.com/AgoraIO-Extensions/agent-infra/issues/2976) 确认，随 [#2977](https://github.com/AgoraIO-Extensions/agent-infra/issues/2977) 的文档评审合入生效；实现按 #2976 的子票推进。

## 背景

- [平台 PRD §11.2](../prd/PRD-agent-platform-M1.md#112-对话能力) 原规定不展示模型内部思考原文，[工程 Spec §6.1](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#61-平台模块) 把它排除在 Conversation 之外，事件表也不保存。
- Owner 需要标准 Codex 模板使用 DeepSeek，并在 Web 会话和企微智能机器人里展示思考过程。
- 固定 Codex 0.153.0 的 app-server 已经发出原始推理与推理摘要的增量通知，Driver 目前丢弃它们。
- 固定 Codex 只认内置的 GPT 模型列表；`codexModelProfiles` 由该列表生成，DeepSeek 无法通过准入。

## 决策

1. **数据归属。** 思考过程属于 Conversation 的会话正文，只包含模型以明文提供的原始推理或推理摘要。读取权限、主体隔离和保留规则与回答相同。加密推理、签名和被隐藏的思考不保存、不展示。日志、指标、Trace、审计和遥测的排除规则不变。
2. **事件版本。** Runtime 事件新增 `schemaVersion: 2`、`type: "reasoning"`，`payload: { kind: "raw" | "summary", delta }`，单条上限与正文增量相同（64 KiB）。Worker 保存为 Runtime 来源的 `reasoning.delta`（`{ type, kind, text }`），沿用现有事件表、游标与去重，不需要数据库迁移。浏览器契约只在 V2 增加该事件；V1 SSE 跳过它并推进游标，与 `browser.handoff`、`execution.operation` 的先例相同。只做加法，既有 V1 与 V2 组件保持不变。
3. **正文不混入思考。** 回答正文、任务输出和企微答案只拼接 `text.delta`。
4. **Task API 不暴露。** 任务查询、输出与事件订阅跳过 `reasoning.delta` 并推进游标，[PRD §10.4](../prd/PRD-agent-platform-M1.md#104-agent-api-与后台任务) 的输出语义不变。外部集成不会因为 Agent 换了模型而收到新的事件类型；以后要开放需要另行决策。
5. **批量与顺序。** Driver 把思考增量与正文增量放进同一批持久提交，保持到达顺序，见 [Agent Runtime HLD §8.2](../architecture/HLD-agent-runtime-M1.md#82-事件去重)。
6. **发布顺序。** 先发布 Platform（Worker、API、Web），再发布 Runtime。旧 Worker 把不认识的 V2 Runtime 事件当作依赖不可用，停在原游标重试，任务无法推进。
7. **Codex 模型目录。** 标准 Codex 模板通过仓库内受控脚本生成的模型目录接入获准模型：以固定 Codex release 的内置目录为基础，追加经评审的条目。目录烘焙进 Runtime 镜像的只读路径，由 Bridge 以 session flag 传给固定 Codex，Driver 精确校验该配置项；能力元数据的来源约束见[工程 Spec §10.8](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#108-codex-原生模型传输边界)。`codexModelProfiles` 仍只由模板与镜像 Digest 决定，运维步骤见 [Platform API 部署说明](../../deploy/platform-api/README.md#标准-codex-模板的模型画像)。
8. **企微展示。** 只有执行完成的回复组合思考过程，组合、截断与各传输方式的差异见 [企微文本渠道部署](../architecture/WECOM-text-deployment.md#思考过程)。

## 风险与边界

- 思考内容可能复述用户输入或工具结果中的敏感片段，因此按会话正文保护；凭证片段仍由模型传输的凭证匹配拦截。
- 推理文本可能比答案长。单条上限、Host 事件页上限与企微的有界读取都不放宽。
- 不在本决策内：Claude、OpenCode 与 Pi 的思考过程；Task API 开放思考过程；企微边想边发；回调机器人在验证官方样式前不附带思考过程。

## 备选方案

- **把思考拼进回答正文：** 污染任务输出和历史正文，Web 无法折叠，拒绝。
- **复用 `execution.detail`：** 它是 Agent 自报的有界过程摘要，不承载流式大文本，语义不同，拒绝。
- **给 V1 `text` 事件增加 `kind` 字段：** 改变既有 V1 组件，违反只做加法的兼容规则，拒绝。
- **通过 Runtime 配置或 Secret 下发模型目录：** 需要改 Runtime 配置契约和 Landlock 可读集合，也不能随镜像 Digest 追溯，拒绝。
