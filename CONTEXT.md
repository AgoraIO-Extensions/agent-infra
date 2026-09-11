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

**Provider Connection**:
Principal 在 Connection 中建立的、对应一个稳定外部账号的连接。
_Avoid_: PAT、ConsumerInstance
