# Domain Docs

本仓库采用 single-context domain docs 布局。Domain docs 只补充稳定词汇和已批准技术决策，
不覆盖正式 PRD、工程架构 Spec 或开发工作流 Spec。

## Before exploring

按 `AGENTS.md` 的 Source Of Truth 顺序读取与任务相关的 PRD 和 Spec，然后按需读取：

- 根目录 `CONTEXT.md`
- `docs/adr/` 中与当前变更相关的 ADR

文件不存在时继续工作，不提前创建占位文件或目录。只有领域词汇或架构决策稳定后，
才通过 domain-modeling 流程创建。

## Layout

- `CONTEXT.md`：全仓统一领域词汇、边界和避免使用的同义词。
- `docs/adr/`：已批准的跨模块技术决策。
- 子项目只有出现稳定且不同的领域语言或决策边界时，才增加局部 Context 或 ADR。

## Vocabulary and conflicts

Issue 标题、接口、类型、测试和文档使用 `CONTEXT.md` 中的统一术语。需要的概念尚未定义时，
先判断是错误用词还是领域模型缺口。

输出若与 ADR、PRD 或 Spec 冲突，必须显式指出；不能由较低层级文档静默覆盖权威结论。
