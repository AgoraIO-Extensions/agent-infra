# Agent 平台 M1 领域上下文

## Builder

Builder 是运行在标准模板 Agent 上的普通任务能力。它通过现有 Connection 读取和修改代码，使用隔离分支和临时工作区提交可审计的 PR；镜像由仓库已有 CI 或用户自己的构建流程提供。Platform 不为 Builder 增加独立 API、构建服务、凭证或生命周期。

## 多服务系统

多服务系统是一个 `self-managed` Agent 版本中的一组服务。服务集合、入口服务、镜像 Digest、配置和部署资源随同一版本整体管理，平台不把每个服务当作独立 Agent。

## 受限资源描述

多服务版本使用内联的受限 Kubernetes 资源描述。允许的资源类型、字段白名单、入口标记、规格档位、网络边界和平台注入字段由正式工程 Spec 与契约定义；Compose 和 Helm 是 Builder 或部署流程的输入，不是 Platform API 的请求格式。

## 入口服务

入口服务是多服务系统唯一对外提供平台路由的服务。其他服务只在同一 Agent 的内部网络边界中可达。平台负责注入 Service、NetworkPolicy、入口路由和服务端资源身份，并在资源内容变化后要求重新准入。
