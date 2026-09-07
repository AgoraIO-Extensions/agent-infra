# ADR: 独立部署 Connection Web

## 状态

已接受，用于 Connection M1。

## 背景

Connection 与 Agent Platform 拥有不同的身份、授权、数据和发布边界。把 Connection 管理页面放入 Platform Web Shell，会让 Platform 前端承载另一个系统的登录、OAuth、Grant 和审计体验，并容易诱导实现把两个系统的数据拼成新的授权结论。

Connection 还需要自己的员工登录和管理员待处理流程。两者的安全交互、故障范围和发布节奏均不同于 Agent Platform 对话产品。

## 决策

1. `connection-web` 是独立构建、镜像和部署的 React SPA；Platform `web` 不承载 Connection 管理页面。
2. Connection Web 只调用版本化 Connection Browser API。Principal、Grant、Connection、Credential 和管理员权限全部由 `connection-api` 服务端解析。
3. Connection Web 与 Connection API 使用同一批准 public origin；SPA、Browser API、OAuth、Catalog 和 delegated 路由由部署显式分流，不使用跨域 Cookie或公共 tunnel补偿错误路由。
4. Agent Platform 只展示受控跳转入口或调用 Connection 契约，不复制 Connection 页面和可写状态。
5. Connection 登录、账号、Grant、调用记录和管理员处理页面默认使用简体中文。

## 影响

- Connection 前端可以独立发布和回滚，不依赖 Platform Web 版本。
- 新增一个镜像和部署单元，但不新增数据权威；所有状态仍在 Connection API/DB。
- 跨产品集成必须通过稳定 URL、版本化契约和 `callId`，不能通过共享前端状态完成。

## 备选方案

- **复用 Platform Web Shell：** 部署单元更少，但产品、身份和授权边界混合，拒绝。
- **由 Connection API server-render 全部页面：** 协议入口与产品 UI 耦合，无法保持独立前端交付，拒绝。
