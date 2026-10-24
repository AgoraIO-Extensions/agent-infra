# ADR-0032：会话 Sandbox 文件交换与企微媒体

## 状态

已采纳。本文随 [#3224](https://github.com/AgoraIO-Extensions/agent-infra/issues/3224) 的文档评审合入，决策来源见 [#3221](https://github.com/AgoraIO-Extensions/agent-infra/issues/3221)。实现归属如下：

- [#3225](https://github.com/AgoraIO-Extensions/agent-infra/issues/3225)：附件物化；
- [#3226](https://github.com/AgoraIO-Extensions/agent-infra/issues/3226)：回答内引用发布；
- [#3227](https://github.com/AgoraIO-Extensions/agent-infra/issues/3227)：企微入站；
- [#3228](https://github.com/AgoraIO-Extensions/agent-infra/issues/3228)：Web；
- [#3229](https://github.com/AgoraIO-Extensions/agent-infra/issues/3229)：企微出站；
- [#3230](https://github.com/AgoraIO-Extensions/agent-infra/issues/3230)：固定环境验收。

本 ADR 修订 [ADR-0014](../architecture/ADR-0014-runtime-execution-file-bridge.md) 的 §3、§5、§6 在标准模板 Session Sandbox 中的适用方式，并按 [ADR-0031](0031-enable-native-tools-inside-session-sandbox.md) 对结果发布归类。工程边界只在以下位置完整定义：[工程 Spec §15.4.4](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1544-会话-sandbox-文件交换) 与 [§14.2.3](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1423-媒体)。各 Driver 的映射见 [Runtime HLD 8.5.5](../architecture/HLD-agent-runtime-M1.md#855-会话-sandbox-文件交换)。

## 背景

[平台 PRD §12.1](../prd/PRD-agent-platform-M1.md#121-附件和结果文件) 要求：四个标准模板在 Web 和平台托管企微都支持附件与结果文件；企微按 Channel 能力和企微接口限制收发文本、图片和文件。ADR-0031 之后，Agent 在 Session Sandbox 内用原生工具处理文件。实际行为与这些要求的差距如下：

- **附件**：ADR-0014 §3 要求附件只物化到 Runtime 专属临时目录。Codex 只接受图片，作为临时 `localImage` 交给模型，其他类型直接拒绝；其余 Driver 也只接受图片。原生工具读不到工作区外的附件，PDF、表格这类文件到不了 Agent。
- **结果文件**：四个 Driver 只会把 apply_patch、Write/Edit 或 ACP diff 产生的单个 UTF-8 文本文件隐式发布为 `text/plain`，每次执行一个。shell 生成的图片和二进制文件发不出去，每改一次代码却会收到一个文件。
- **原生协议**：固定 Codex 版本的最终回答 `agentMessage` 只有文本，Claude、Pi 也是如此。只有 ACP 的 `agent_message_chunk` 能携带 `image`、`resource_link` 块。
- **企微**：长连接入站没有取下载解密所需的 `aeskey`，也没有 media resolver；出站会丢弃结果文件，却返回 `sent`。回调模式带结果文件时整条回复失败。固定版本的企微 SDK `@wecom/aibot-node-sdk@1.0.7` 已提供 `downloadFile`、`uploadMedia`、`replyMedia`。

同类产品的做法（只读调研，见 #3221 评论）：

- **Magic**：附件放进工作区，再把路径写进提示词。交付物由回答中的路径引用列出，例如 `[@file_path:]`、Markdown 图片；微信渠道按最终回复里的媒体标签发送。
- **Paseo**：附件以路径文本交给 Agent，图片以 Markdown `file://` 引用回传。
- 两者都没有专门的发送文件工具。

## 决策

1. **附件进入会话工作区。**
   - Driver 只通过 FileBridge 的 `readInput` 读取本次 Grant 精确列出的附件，物化到当前 Conversation 工作区内由平台派生的目录。目录名由 fileId 派生，文件名经过清洗；逐级拒绝链接和越界。
   - 工作区副本不是权威数据，权威字节始终在 File Authority 中。Agent 改写或删除副本属于 Sandbox 内的本地操作；重新物化时，平台在原路径恢复副本。
   - 平台生成的附件清单只追加到原生输入，不改写平台消息、事件或审计。
   - 图片仍同时走原生图片输入。
   - 可接受的类型和大小取 FileLimits 三方交集，不再由 Driver 写死图片集合。
   - 附件属于该会话的工作区数据，保留到 Session 结束、随 Sandbox PVC 回收。重试或重新生成时，用新 Grant 重新核对内容并复用同一路径。
   - Host 内部临时路径、对象引用和 File Grant 不进入 journal 或事件。Codex Skill 的执行期文本输入不变。
2. **回答内文件引用协议。**
   - Agent 要把文件交给用户，就在最终回答里用专用 scheme 写 Markdown 链接或图片，路径相对工作区根目录：`[说明](sandbox:out/report.pdf)`、`![说明](sandbox:out/chart.png)`。
   - 代码块和行内代码中的内容、普通相对链接、裸路径都不算引用。
   - Turn 正常完成、写终态之前，Driver 解析最终回答，按首次出现顺序去重，每次执行最多发布 10 个。逐个校验以下各项，通过后经 `writeResult` 发布：
     - 路径在工作区内；
     - 以 `O_NOFOLLOW` 打开，必须是普通文件；之后的读取、类型识别和上传都使用这个文件描述符；
     - 媒体类型按实际字节识别；
     - 类型和大小在 FileLimits 内。
   - Turn 失败、取消或 unknown 时不发布。
   - 平台在各模板的开发者指令或系统指令里固定说明这条约定。指令不是能力来源，模型、Owner 和工作区文件都不能改写。
   - ACP Agent 的 `image` 块直接发布；指向工作区内文件的 `resource_link` 按引用处理。
   - 停止 apply_patch、Write/Edit 和 ACP diff 的隐式发布。
3. **发布属于平台中介操作。**
   - 结果发布是 ADR-0031 定义的“平台文件与接口操作”。每个引用先持久记录 intent，再经运行期文件交换核对当前授权，最后记录完成、失败或 unknown。unknown 沿原意图核实，不盲目重发。事实中不含路径和文件内容。
   - 附件读取是 Turn 提交准备的一部分，沿用 Execution Grant 和文件交换的当前授权，不另记工具事实。
4. **`result.file` V2。**
   - 新增 V2 事件，在 V1 字段之外携带规范化的 `workspaceReference`，可为 null。该值在分配结果意图时写入 File 记录，Store 持久化前核对两者一致。
   - V1 读取方仍只收到 V1 事件，做法与 `model.selection.fell_back` V2 相同。
   - Web 依据 `workspaceReference` 把回答中的引用对应到 fileId：图片经 File Grant 取得内存 Blob 后内联显示，文件显示为文件卡。其他模型给出的图片 URL 仍不加载。
5. **企微智能机器人长连接入站。**
   - 处理的消息类型：
     - image、file、video：取下载地址、`aeskey` 和文件名；
     - voice：按转写文本处理；
     - mixed：拆成文本加图片。
   - Worker 在受理事务之外，用固定版本 SDK 下载并解密，有界限制时间和大小，按实际字节识别类型，经 File Authority 写入绑定本发送者和会话的 attachment。受理事务只绑定已确认的附件。
   - 类型或大小不符、下载失败或地址过期时，不调用 Agent，在回复中说明原因。
   - 下载地址和 `aeskey` 只在 Worker 内存中短暂存在，不进入请求摘要、回执、日志、审计或事件。
6. **企微智能机器人长连接出站。**
   - Core 在组装回复时把回答中的引用改写为文件名，写明会在下方发送，或未发送的原因。持久事件不改。
   - 文本流结束后，按引用顺序逐个读取已确认的结果文件，每次重新核对当前授权和回复路由，再上传临时素材并被动回复。类型映射：
     - png、jpeg、gif 不超过 10MB：图片消息；
     - mp4 不超过 10MB：视频消息；
     - 其他文件不超过 20MB：文件消息。
   - 超过企微限制或频率限制的文件不发送。
   - 回执状态：全部送达为 `sent`；文本已送达、有媒体失败或未确认为 `unknown`；什么都没发出为 `failed`。按文件记录发送进度，恢复时不重发已受理的媒体。
7. **自建应用与回调模式。** 这两种模式本期声明为不支持媒体：
   - Core 发送前去掉结果文件，并在文本中说明，文本照常送达；
   - 收到入站媒体时回复不支持，不调用 Agent；
   - 不再静默丢弃，也不再整条失败。

   真实媒体收发另行排期。

## 影响

- ADR-0014 的以下条款对标准模板 Session Sandbox 的业务附件不再适用：§3 只物化到临时目录、§5 只接受 Driver 写死的媒体类型、§6 终态清理。Host 自己的临时副本仍按 §6 清理。§1、§2、§4 和 V4 文件交换不变。
- 工程 Spec 原先把“企微媒体映射、具体 Driver 文件桥接”列为后续整装，改由 §15.4.4 与 §14.2.3 规定；四模板文件 E2E 由 #3230 验收，完成前不能宣称已交付。
- 隐式发布停止后，编辑代码不再产生结果文件。之前依赖这一行为的 Driver 测试，改为验证引用发布。
- 企微用户能直接收发图片和文件，Web 回答中能内联看到 Agent 发的图片。两者都依赖部署声明三方 FileLimits；声明缺失时按 Spec 拒绝，固定环境的装配由 #3060 负责。

## 备选方案

- **新增 `send_file` 工具。** 否决：
  - 需要在 Codex dynamic tool 和三个 MCP 中分别声明；
  - 依赖模型的工具调用能力；
  - 权限屏障与引用协议相同，没有额外收益；
  - Magic 也已废弃带文件参数的 `finish_task`。
- **自动发布本轮变更的全部文件。** 否决：代码修改和中间产物会刷屏企微，也会误发不打算交付的文件。
- **把普通相对链接或裸路径当作引用。** 否决：Agent 解释代码时常写 `[app.ts](src/app.ts)`，会误发源码。
- **附件放在工作区之外，只把路径告诉 Agent（Paseo 的做法）。** 否决：Codex 的 Conversation 文件边界只允许访问本会话工作区，工作区外的文件原生工具读不到。
- **只用 ACP 协议块传文件。** 否决：其他三个模板的原生最终回答只有文本。ACP 块作为补充保留。
