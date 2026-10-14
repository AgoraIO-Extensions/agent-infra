# ADR-0027：多服务使用受限的标准 Kubernetes 资源描述

## 状态

已采纳

## 背景

自定义 Agent 可能由多个服务组成，但 Platform 需要保持一个 Agent 的版本、授权、升级、回滚和失败语义。直接接受 Compose 或任意 Helm 会把部署权限和 Kubernetes API 面暴露给请求方。

## 决策

M1 只支持 `self-managed` 多服务 Agent。创建或升级请求以内联的受限 Kubernetes 资源描述提交，允许 Deployment 或 StatefulSet、Service、ConfigMap、PVC 和发布前迁移 Job。契约固定字段白名单、入口 annotation、Digest 镜像、规格档位和大小上限；Platform 注入名称、标签、ServiceAccount、NetworkPolicy、入口路由和服务端资源身份。入口服务是唯一外部路由，其他服务只在 Agent 内部可达。Compose 与 Helm 不属于 Platform API 请求格式。

多服务仍是一个 Agent 版本。平台按最终资源内容准入，Worker 只调谐已准入版本；内容变化必须重新准入。服务切换不承诺分布式原子性，数据库迁移和业务数据兼容由 System Owner 负责。后续票按契约 seam、最小两服务 tracer bullet、有状态服务、迁移、ConfigMap、规格、升级回滚和 Web 申请逐步交付。

## 取舍

受限资源集减少任意 Kubernetes 能力、跨 Agent 网络和权限逃逸风险，也允许复用现有 Worker 调谐和 Agent 生命周期。代价是 M1 不支持任意 Compose/Helm 语义，复杂系统需要 Builder 将其转换为契约允许的资源描述。
