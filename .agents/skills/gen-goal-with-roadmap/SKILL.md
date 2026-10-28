---
name: gen-goal-with-roadmap
description: 从当前 Roadmap、Issue 与 PR 事实生成有边界的 Coordinator Goal。
disable-model-invocation: true
---

# 从 Roadmap 生成 Goal

仅在用户显式调用 `$gen-goal-with-roadmap` 时使用本 Skill。它只读收集当前事实，输出最多三个候选调用或一份 Coordinator Goal 指令。生成期间不创建 Goal、启动 Subagent、修改 GitHub/Project/Git/工作树或发送通知。

## 事实输入

1. 判断用户是否给出 Map 或 Issue 引用。无引用时读取开放的 `wayfinder:map` 与实现 Issue；有引用时逐一解析用户指定的对象。不能从标题或旧对话猜测 Issue 编号。
2. 从 GitHub 回读每个相关 Issue 的状态、更新时间、稳定 `AC-N`、Map/里程碑、Project 字段及原生依赖；回读关联 PR 的状态与 head、assignee、分支和工作树占用。为这些事实保留来源链接与观察身份。GitHub Issue、原生依赖、PR、CI 和 Project 是正式事实源，本地缓存只提供查找线索。
3. 按 `frontier.ts` 的输入契约组织本次只读观察，并通过标准输入交给该脚本。输入包含已核实的 Issue、依赖、归属、范围、Project 状态和证据指针；验证入口只使用仓库根目录支持的 `pnpm` 脚本。不得传入凭证、个人 userid、会话正文或机器绝对路径。脚本只从标准输入读取并向标准输出写结果。
4. 任何必要事实不可读取、依赖状态不完整或归属不明时，停止生成并报告具体缺口及来源。不要用旧快照补齐，也不要手工绕过脚本的拒绝结果。

## 两种输出

- **无引用：** 脚本按可核实的优先级 `P0 → P1 → P2`、再按 Issue 编号排序开放、依赖已完成且无人占用的 frontier，最多输出三个候选。每个候选包含 Map/Issue 引用、证据和完整的后续调用，例如 `$gen-goal-with-roadmap #123`。用户只回复序号、字母或标题时，要求其给出完整显式调用。
- **显式引用：** 脚本一次校验全部 Map/Issue 引用、Map 归属、原生依赖方向、范围、稳定 AC 与当前 ownership。任一项不明确、不满足或需要扩大范围时，整次拒绝；通过时只输出一份 Coordinator Goal 指令。新解锁的 Issue 不自动进入这次 Goal。

## 快照与 Goal 契约

快照冻结的不只是 Issue 集合，还包括每个选中 Issue 的状态与修订、Map/Project 字段、依赖及其状态、assignee、PR/head、分支、工作树占用、base/head 和证据身份。输出携带内容摘要和来源；这些事实变化时必须重新显式生成，不能沿用旧快照。

生成的 Goal 必须给每个实现 lane 声明唯一 primary Issue、稳定 AC、owner/writer、工作树与分支、base/head、文件及外部资源边界、验证入口和预期 PR。共享入口及集成版本由 Coordinator 持有；未分配的 owner 是进入实施前必须解决的条件，不得默认为当前 Agent。

Goal 使用 `Ready to implement → Implemented → Integrated → Accepted` 四阶段。每次推进绑定当前 exact head；`Integrated` 要求同一组合版本启动并执行一条纵向旅程；`Accepted` 还要求产物身份、环境、命令、结果、限制及人工门禁。独立 Verifier 执行真实入口或用户旅程，只给出证据与 findings，不修改实现或自批。

Idle、timeout 和失败不释放 ownership。交接记录必须包含原/新 owner、当前 head、已完成 AC、剩余工作、blocker、下一动作和证据。重试次数有限且绑定故障指纹；耗尽后记录可恢复条件。权限、范围、契约、受保护路径或凭据缺失都停止受影响 lane，不新增豁免或第二套依赖图。

终态重新读取 Issue、原生依赖、PR、CI、merge SHA、合并后检查、分支/工作树和 Project 字段，逐 lane 区分 Delivered 与经人工决定退出的工作。审批与人工验收等待保留为待办，不推断为已通过。

## 返回前检查

1. 无引用模式只有零到三个完整后续调用；显式模式只有一个冻结快照及一份 Goal，或一个原子拒绝结果。
2. 每项纳入、排除和依赖判断都有当前来源。快照摘要覆盖依赖、归属、PR、分支、工作树、base/head 与 Project 状态；缺失事实必须显式拒绝。
3. Goal 含 lane 边界、四阶段、当前 head、独立 Verifier、交接、有限重试与终态回读。
4. 输出不含凭据、私人通知设置、个人 userid、原始会话正文或机器绝对路径。返回脚本的实际结果，不另造通过结论。
