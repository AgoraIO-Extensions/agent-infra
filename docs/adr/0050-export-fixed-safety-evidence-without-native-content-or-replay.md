# ADR-0050：安全验收证据只导出固定结果，不导出原生内容，不重放旧调用

## 状态

提案，归属 [#4358](https://github.com/AgoraIO-Extensions/agent-infra/issues/4358)，服务
[#2857](https://github.com/AgoraIO-Extensions/agent-infra/issues/2857) 的 U1–U3。须经非实现方独立评审后合入。
工程规则只在
[工程 Spec §18.5](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#185-runtime-安全验收证据)
与 [§9.3.2](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#932-原调用准入核验授权)
维护，实现时序在
[Runtime HLD §8.5.6](../architecture/HLD-agent-runtime-M1.md#856-安全验收证据的实现时序)；本 ADR 只记录
取舍，不单独覆盖 PRD、工程 Spec 或 HLD。

## 问题

[#2857](https://github.com/AgoraIO-Extensions/agent-infra/issues/2857) 要求现场证明三件事：跨 Session 的文件、环境、进程、工作区、记忆与模型上下文访问被实际
拒绝；撤权后 Host 收到、封闭并中断原执行的先后；旧 generation 或旧 fence 的原调用被拒绝。
Runtime 对生产基线的只读核对（[#2857 评论 7069045353](https://github.com/AgoraIO-Extensions/agent-infra/issues/2857#issuecomment-7069045353)）
表明三者都没有完整的合法出口：

- 原生工具事实只有 operation/attempt 与状态，文件交换的 length/hash 不说明是哪次原生读写产生的。
- 现有 3 个排空码是条件式的，没有收到、校验、持久封闭、interrupt 写入与原生 ACK 这些阶段。
- 内部准入 guard 与 generation tombstone 存在，但 `authorizeExternalAction`、V3 status 等入口可能
  绑定或恢复状态，不能当作无副作用的核验入口。

旧做法是让模型报告拒绝结果、由管理员读盘，或按原日志方案重跑业务。这些做法要么不可信，要么会
导出正文与路径，要么重复副作用。

## 决策

- 三类证据共用一个版本化的受限记录族，只导出固定的结果类、布尔值和本人合成文件的
  length/hash，绑定原 Execution、operation/attempt、Sandbox、Pod、fence 与时钟。命令、参数、
  stdout、正文、私有路径和凭据都不导出。
- 原生隔离结果由固定的验证叶子在真实原生接缝下产生，模型上下文由既有受保护模型传输在内存中
  观察合成 marker。无法证明结果与原生进程关联的 Adapter 保持 `UNPROVEN`，不改上游。
- 控制时序是 Host/Driver 在真实观察点写出的固定 stdout 诊断，不改变业务 wire；日志丢失即为未证明。
- 旧代次拒绝通过独立 purpose 的只读准入核验取得，复用原调用的准入谓词，从不 dispatch，也不向
  验收方交付或重放旧 Grant、Key、Token 与原调用。
- 隔离证据与核验结果存入 Platform DB 的独立受限记录，Host 侧使用与业务 journal 分开的证据日志；
  证据失败不影响业务事件、终态与 ACK。

## 备选

- **通用原生输出导出接口。** 能看到一切，但会把命令、参数、文件正文与路径交给调用方，也给模型
  伪造结果留下入口。不采用。
- **采信模型或工具自报的 JSON，或由管理员 root 读盘。** 模型输出不是执行证据；root 读盘以更高权限
  读取目标，不能证明业务 UID 下的拒绝。不采用。
- **按原 Y/T 日志方案重跑业务。** 生产基线上缺少的出口不会因重跑出现，还会重复副作用。不采用。
- **把 `authorizeExternalAction`、status 或 `native_metadata_read` 改作核验入口，或让验收方重放旧
  token。** 前两者可能绑定、恢复或推进状态，第三者用途不符；重放旧 token 等于交付业务凭据并可能
  产生旧调用副作用。不采用。
- **把证据塞进 RuntimeEvent V2 payload 或业务 journal。** 改动最少，但会破坏严格 schema，旧端可能
  静默丢字段，证据失败还会挡住业务 ACK。不采用。
- **一个横跨三项的大实现 PR。** 仓库没有禁止，但会把范围小的控制诊断绑在原生可信 producer 与
  旧代次样本门槛上，评审与回滚范围过大。采用一个合同文档 PR 加三个实现 PR。

## 后果

- 新增一类受限证据记录与追加迁移、一个只读核验用途和若干固定诊断，不新增部署单元、Secret 或
  上游补丁；新增挂载、RBAC 或配置另开默认关闭的 helm PR。
- 某个 Adapter 不能证明原生关联时，对应隔离子项长期保持 `UNPROVEN`，需由产品权威另行决定。
- 旧代次拒绝依赖合法的真实恢复失败样本；没有样本时该项保持阻塞，不以离线 fixture 代替。
- 历史 T3/Y2 场景不补造证据，只在新版本上线后的获批场景中取新事实。
