# ACK Directory 身份 fail-closed 接入交接

本页对应 [#3783](https://github.com/AgoraIO-Extensions/agent-infra/issues/3783)，
由 B lane 负责私有候选、脱敏回执和发布准备；企业身份系统负责人提供当前账号状态的权威契约。
既有 clean rebuild 结果不证明私有身份 adapter 安全接线；本项采用定向验证，不重新清空环境。

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

source `3c1f0660bdc4018d7279e0d55868c6cb94c10885` 的独立私有候选已完成 auth 声明移植；
API 40、Worker 39 项非 auth 声明逐字不变，139 项冻结输入未变。30 个受控场景通过，
含缺失、unknown、异常、timeout 的拒绝，原行为红灯及两项语法检查保留。
这些测试抽取身份函数，不加载完整私有模块；`liveAdopted=false`，没有真实授权写入。
公开 LDAP 与 Directory authority 基线分别为 25/25、4/4。
[脱敏交付回执](https://github.com/AgoraIO-Extensions/agent-infra/issues/3783#issuecomment-6596527840)
包含候选和验证摘要 hash；原模块与完整证据留在仓库外。

## 谁提供什么

| 责任人 | 交付 |
| --- | --- |
| B lane（部署 adapter 实施者） | 从当前配置生成独立候选；保存原始 SHA、精确 diff、source/image 绑定及 Secret UID/RV；补负向测试、定向 rollout/rollback 计划和脱敏回执。不得修改已验收 seed |
| 企业 LDAP/SSO 身份系统负责人（由用户指定联系人） | 当前账号资格的可信 reader/接口与身份键映射；disabled/revoked/unknown 的语义、时效和超时行为；一个允许和一个已失效账号的受控验证方法。凭据沿用私有通道，不贴 issue |
| 环境 owner（B lane） | 核查无活跃执行窗口、配置 CAS、回滚来源、TLS 与业务回归；窗口与对象可从已有权限查询，不要求用户重发本地已有 artifacts 或 Secret 元数据 |

用户真正需要补充的是：**指定企业身份负责人，以及其认可的当前账号状态机制**。
在取得该契约前，可以完成离线 fail-closed 候选与负向测试；不得声称有效账号保持可用或 live adoption 已完成。

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
5. 缺少契约或定向验证未通过时，#3783 保持 needs-info。若必须拆交付，先交 API picker/authority，
   再交 Worker 当前账号/sender；两步分别验证，不能把半套 adapter 标记为完成。

公开 [LDAP 负向测试](../../packages/identity/src/ldap.test.ts) 和
[Directory authority 测试](../../apps/platform-api/src/directory-authority.test.ts) 是复用基线；
私有模块仍需自己的执行回执。收尾票据与性能签收见 [ACK 工作流](ACK-REDEPLOY-WORKFLOW.md)。
