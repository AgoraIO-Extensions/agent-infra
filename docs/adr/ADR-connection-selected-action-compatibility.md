# Connection 已选能力兼容与凭据权限更新

- 状态：Accepted
- 需求：[Issue #2051](https://github.com/AgoraIO-Extensions/agent-infra/issues/2051)

## 背景

把整个凭据 scope 摘要变化等同于客户端授权变化，会使未使用新增能力的客户端也停止工作。
把目录中所有未授权项视为新增，则会反复提示用户以前主动取消的能力。

## 决策

以原已选能力的可证明兼容性决定是否继承授权，完整 scope 摘要仍绑定实际执行和新的授权预览。
凭据重新验证更新账号权限快照；新增能力必须由用户另行选择确认。新增提示以原 Consent
对应的发布目录为基线。完整约束见 [HLD 30.0](../architecture/HLD-connection-M1.md#300-provider-upgrade-campaign)。

## 影响

兼容更新不打断既有调用；缺失原权限或兼容证明时只限制受影响授权。原 Consent 和历史目录
保持不可变，不增加客户端自动扩权、原始凭据导出或自动恢复已撤销授权的路径。
