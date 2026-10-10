# StaticSpaces v3 受监督试点

状态：Accepted，操作者于 2026-10-10 批准。

批准与实现由 [#1714](https://github.com/AgoraIO-Extensions/agent-infra/issues/1714) 跟踪。
本决定延续[原受监督范围](ADR-connection-static-spaces-supervised-pilot.md)，不表示正式 onboarding
或广泛生产、Legal/Security 签收完成。

## 原试点结果

v2 已通过正式页面完成公司审批、现有 Token 接入与七项 Codex Consent，真实 MCP 身份读取成功。
文件列表 prefix 的末尾斜杠通过公开 Schema，但被 Adapter 拒绝，Call FAILED 后按规则永久关闭。
未执行 WRITE；已撤销本次 Grant，保留 Token、账号、Call 和关闭审计。

## 新绑定

- ProviderRelease：`static-spaces-connection-v3-supervised`，七项 Action 使用 `@v3`。
- 批准记录：`1714`；v1/v2 源码、digest、定义、历史 Call 与关闭记录保持不变。
- Principal、Consumer、外部账号、空间、Application、owner/viewer group 与原 ADR 相同。
- 固定窗口仍为 `2026-10-10T05:00:00Z` 至 `2026-10-11T05:00:00Z`，不顺延、不续期。
- WRITE 仍仅限原 run 的 `connection-onboarding/` 子目录，必须包含原 ownership marker，
  `overwrite=false`；不新增 Action、不扩大空间或成员权限。

## 修复与重新授权

新 Schema 和指南须与 Adapter 的 prefix 路径限制一致，在 Call/Provider 提交前拒绝非法参数。
保留其他所有身份、字节/归档、单次提交、期限和失败/未知持久关闭规则。
通过 forward-only migration 绑定新批准记录，并走正式发布、公司审批及七项新 ActionVersion
的明确 Consent；不重开 v2，不删除或改写其 closure。

真实 MCP、幂等、bytes/hash、Call/Effect/Dispatch 和逐项清理证据由
[#1687](https://github.com/AgoraIO-Extensions/agent-infra/issues/1687) 继续跟踪。
正式 onboarding [#1672](https://github.com/AgoraIO-Extensions/agent-infra/issues/1672) 保持独立且未完成。
