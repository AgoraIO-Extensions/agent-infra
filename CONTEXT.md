# Agent Infrastructure

Agent Infrastructure 定义 Agent Consumer 使用 Connection 访问外部 Provider 时的身份、授权和凭据边界。

## Language

**Principal**:
Connection 从受信身份源识别的员工或受管理服务主体。
_Avoid_: 用户名、邮箱账号

**Consumer**:
使用 Connection 的稳定客户端或服务产品，例如 RehoboamAI 或 Codex。
_Avoid_: Agent、调用方名称

**ConsumerInstance**:
一个 Consumer 内可独立认证、审计和撤销的安装、服务实例或 PAT token instance。
_Avoid_: Consumer、Provider Connection

**PAT Binding**:
当前 Principal 为具名 Consumer 的一个 ConsumerInstance 确认并交付独立 Connection PAT 的一次性过程。
_Avoid_: Provider 授权、账号连接

**Provider OAuth Scope**:
Provider 授予 Connection Credential 的外部权限上限，不等于 Consumer 的 Connection 授权。
_Avoid_: Action 权限、Consumer scope

**Consumer Declaration**:
Consumer 按 ProviderRelease 发布的、可向用户申请的 ActionVersion 最大集合；声明本身不授予账号访问权。
_Avoid_: Connection Grant、OAuth scope

**Connection Grant**:
Principal 明确确认的 Consumer、Provider Connection 和 ActionVersion 非空子集；每次调整产生不可变 replacement。
_Avoid_: PAT、Consumer Declaration

**Provider Connection**:
Principal 在 Connection 中建立的、对应一个稳定外部账号的连接。
_Avoid_: PAT、ConsumerInstance

**Provider Connection Upgrade**:
在认证方式、Credential scope 与稳定外部账号兼容时，复用 current Credential 将 Provider Connection 迁移到新的 ProviderRelease。
_Avoid_: Credential Rotation、Consumer 授权

**Credential Rotation**:
用户为同一 Provider Connection 提交新 Credential 并替换 current CredentialVersion 的过程。
_Avoid_: Provider Connection Upgrade、重新授权客户端

**Verification Evidence**:
绑定 exact ProviderRelease、ActionVersion、隔离测试边界和终态结果的脱敏验证证明。
_Avoid_: 测试计划、Mock 成功、其他 ActionVersion 的历史结果

**Verified ActionVersion**:
具备当前 Verification Evidence、可以进入对外发现和执行集合的不可变 ActionVersion。
_Avoid_: 已实现 Action、已有测试策略、曾通过旧版本测试
