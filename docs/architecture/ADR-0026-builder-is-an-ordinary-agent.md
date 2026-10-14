# ADR-0026：Builder 是普通 Agent

## 状态

已采纳

## 背景

旧设计把 Builder 当作平台内建的 Build Service，要求平台保存构建批次、管理构建后端、推送镜像并清理未绑定产物。该边界重复了 Agent、Connection 和仓库 CI 的职责，也会让平台持有不必要的源码与构建凭证。

## 决策

Builder 运行在标准模板 Agent 上，复用现有 Conversation、Task、Identity、Connection、审计和 Agent 创建/升级能力。源码读写只能经 Connection 授权，使用隔离分支和临时工作区；Builder 提交可审计 PR。镜像由仓库已有 CI 或用户自己的构建流程提供，Platform 只消费部署批准的不可变 Digest 并执行既有准入和部署流程。

## 取舍

Platform 不再承担通用构建后端、构建批次和构建 GC，减少凭证、源码和跨系统状态的权威边界。Builder 真实端到端运行依赖 Connection 平台 API Provider 和仓库 CI；这些依赖由各自系统交付，不能用 Platform fixture 替代。
