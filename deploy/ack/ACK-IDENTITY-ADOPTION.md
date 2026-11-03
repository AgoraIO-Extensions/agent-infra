# ACK Directory 身份 fail-closed 接入交接

本页对应已关闭的 [#3783](https://github.com/AgoraIO-Extensions/agent-infra/issues/3783)。LDAP 只是临时身份方案，后续迁移 OIDC；本页归档 B lane 的私有候选、脱敏回执和发布准备。用户已明确跳过 live login、TLS adoption 与有效账号正向回归，因此不再等待企业身份负责人、测试账号或当前 LDAP 契约。既有 clean rebuild 结果不证明私有身份 adapter 安全接线；本页仅记录 fail-closed 边界和未来 OIDC 迁移验收要求。

## 最终路径

优先采用 fail-closed：Directory 成员未唯一关联 LDAP，或无法取得可信的当前 LDAP 状态，
均不能成为新增 Owner、access target 或 Worker/channel sender。API picker 不展示这类候选；
历史 canonical ID、旧授权记录和救援入口按现有 Core 规则保留，不删除、不伪造 LDAP UID；
保留记录不保留其有效性，后续使用仍须通过当前资格检查。
新成员没有历史 binding 时省略该授权候选；历史身份仅作为历史引用保留，不能恢复 active 权限。

复用公开平台已有实现：
[LDAP current reader](../../packages/identity/src/ldap.ts) 对缺失 verifier、unknown、异常和超时拒绝；
[API 装配](../../apps/platform-api/src/deployment-entry.ts) 必须提供当前状态 verifier；
[Directory authority](../../apps/platform-api/src/directory-authority.ts) 检查当前组织快照。
这些门禁不自动修复私有模块中的 Directory-only fallback，必须逐个核对 API 和 Worker 的调用路径。

找不到权威状态时，候选应明确拒绝，而不是回退 Directory.active、既往登录成功或本地未禁用。
这可能拒绝原先可用但无法确认当前状态的账号；候选回执必须区分“正确拒绝”和“有效账号回归通过”。
不要求 LDAP 必须存在某个 activeAttribute；使用企业身份系统认可的状态 reader 或账号验证机制。

## 当前交付回执

source `3c1f0660bdc4018d7279e0d55868c6cb94c10885` 的独立私有候选完成 auth 声明移植。
精确 diff、完整源文件和冻结输入清单保存在仓库外私有包；下列摘要绑定具体对象，声明数量不作为安全证明。

| 交付对象 | SHA-256 |
| --- | --- |
| API candidate | `f8de45cc0068f5a58bc619c162a42e1f77e78f7b69d1c87e105e93cacac2943c` |
| Worker candidate | `922cafe8e678974b78fded1d534abdcad582ceba41dc3ee5f91c6a824e968c5f` |
| api.auth-only.patch | `8334bc95b3ed8607f26b2a1e162d4968f261e9a9191eac43c92aa04459222332` |
| worker.auth-only.patch | `3cff4104c138a70621ed24dcab25b7c344d2ec690c29f801d1f6954acbb7d899` |
| verify-offline.mjs | `b3e6c7d582cfc5d1f9a59b399fdc3b52b455dfb5a8d4a87c42c80f3cb8577ac8` |
| verification-receipt.json | `deae6ed6a052c16fde2033dfb1a477ce5cc49acdcc86e916fc33ef0b7c744b98` |

在有权访问的私有包根目录，用 Node 24 执行测试入口：

```bash
node verify-offline.mjs --read-only
```

30 个受控场景通过，含缺失、unknown、异常、timeout 的拒绝；原行为红灯和两项语法检查
另有回执。测试仅抽取身份函数，**不证明完整私有 API/Worker 已接入当前状态 reader，
也不证明 live adoption**。没有真实授权写入。公开 LDAP 与 Directory authority 基线分别为
25/25、4/4。[脱敏交付回执](https://github.com/AgoraIO-Extensions/agent-infra/issues/3783#issuecomment-6596527840)
与测试回执共同保存；完整模块、diff 和凭据不进入 Git。

## 后续 OIDC 迁移责任

LDAP→OIDC 迁移的 owner 需要在未来 OIDC 方案中提供等价的 current-account reader、身份键映射、active/disabled/unknown 语义、时效/超时与异常拒绝合同，并补 linked 正向、TLS/登录态和 picker/authority 回归。B lane 已有 artifacts、候选 hash、CAS/rollback 和 deny-only 测试归档，不要求用户重发。

当前用户决定跳过的 live checks 不由本票代签；归档中的 `liveAdopted=false` 保持事实。无论 LDAP 临时方案还是 OIDC，私有 adapter 都不得恢复 Directory-only fallback，历史记录不恢复有效性。

## 如何验收

1. 先锁定 source、当前私有 API/Worker 文件 SHA、Secret UID/RV 和 imageID。候选只改身份资格
   解析，存量 identity binding、grant、Provider 配置与用户数据不写入。
2. API picker/authority 及 Worker formal/default/legacy resolveUser/sender 均覆盖：unlinked、
   缺失当前状态、unknown、超时/异常、duplicate/email drift、disabled；全部拒绝。
   注入可信 active 状态的受控正例保留原 canonical ID。合成正例不能替代真实 LDAP 资格。
3. 当前状态 reader 接好后，在无活跃执行窗口通过原配置发布路径做定向 adoption；发布前后
   核对 Secret UID/RV/SHA 与 source，遇到并发变更即停止。回滚恢复精确原配置，不重建 namespace。
4. TLS 真实登录/session、只读 picker/authority 和 Worker 身份解析验证有效/无权账号；核对历史
   Owner 救援、旧会话和存量数据仍可回读。失败保留原始回执，不用事后单项成功回填。
5. 本票已按用户决定关闭；未来 OIDC 迁移另行验证上述契约和 linked 正向，不重开本票、不重建 namespace。

公开 [LDAP 负向测试](../../packages/identity/src/ldap.test.ts) 和
[Directory authority 测试](../../apps/platform-api/src/directory-authority.test.ts) 是复用基线；
私有模块仍需自己的执行回执。收尾票据与性能签收见 [ACK 工作流](ACK-REDEPLOY-WORKFLOW.md)。
