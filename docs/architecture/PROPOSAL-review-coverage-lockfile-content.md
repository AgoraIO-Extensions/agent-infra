# 提案：为仅锁文件差异恢复原生 Review Coverage

状态：**Proposed——未批准，不构成实现授权**
负责人：Issue #1304 的 Review 基础设施 lane
Primary：[Issue #1304](https://github.com/AgoraIO-Extensions/agent-infra/issues/1304)
受影响消费者：#1296 / primary #1295
评审基线：`8327fbf911cc2e6761610ac86772c4969bf0771c`

## 待决策事项

请批准或拒绝以下有界兼容边界。仅凭本提案不得修改 provider、workflow、Publisher、Coverage 或漏洞策略代码。

## 证据与当前合同

固定版本的官方 PR-Agent GitHub provider image 在模型调用前，通过 `is_valid_file` 按 basename 过滤 `pnpm-lock.yaml`。Issue #1304 已用记录的精确 source layer 复现 root 和 nested lockfile 行为。上游 `v0.47.0` 及 commit `9ed605cc992f18663d2527c35cf990813fba6654` 仍保留该过滤；上游 PR #3806 只报告被过滤的文件名 metadata，不把锁文件内容发送给模型。

当前仓库 workflow 已经通过 `--diff-file` plain-diff 模式调用固定的官方 CLI，将经过认证的差异写入 `.pr-agent-review-input.diff` 后传入 container，因此不能再把“增加 diff-file 入口”作为修复。当前故障发生在官方 plain-diff 后续路径：#1312 head `255df29f822c8e356356d409d66f628fc6b24466` 的 run `37182555582` attempt `1` 记录了完整的 1184-byte diff（`diffSha256=a1379d721574a144796d2453a1585f3ac0fc5bbfcd29b66c6aef16a205e2e6ff`），运行时记录 2,544 tokens，低于 300,000 上限，但随后输出 `Empty diff for PR: local_diff`。没有产生有效 Review receipt，Coverage 保持 `review-run-failed`。日志确认已进入 `PlainDiffGitProvider`；后续诊断必须覆盖文件可见性/内容传输、CLI 参数解析、provider 加载差异以及输出/receipt 链路。

工程 Workflow Spec §7.3 仍是权威：必须有 exact current-head provider 证据、确定性的 token decision log、同一 run/attempt 的 native Review publication receipt、专用且只检查的 Coverage publication，并对缺失、非法、截断、旧 head 或 provider 不匹配输出 fail closed。

## 推荐决策与精确改动面

当前 pinned image 的 source layer `sha256:68a027dc7ba9a398a9ef655df14122cab846531270b81536ee9008c410a7bd7a` 已回读 `language_handler.py`（SHA-256 `37453385f735cc3e14cbe531a5768e82ad0ce9bd583e97652adbe32cb4d94637`），其中 `is_valid_file()` 硬编码拒绝 root/nested `pnpm-lock.yaml`。固定 `v0.47.0` 上游原函数链进一步显示：`PlainDiffGitProvider.get_diff_files()`（`plain_diff_provider.py:48-91`）先解析并保留 `FilePatchInfo`；`pr_processing.py:167-169、295-296、838-840` 随后调用 `sort_files_by_main_languages()`，`language_handler.py:110` 再无条件调用 `filter_bad_extensions()`。因此 root/nested lockfile 在进入 `pr_generate_extended_diff()` 前被丢弃，lockfile-only 的模型 diff 为 0 bytes；mixed diff 只留下普通源码文件。此前只改 provider 方法的边界不完整。当前 pinned-image 证据仅直接覆盖 `language_handler.py`；其余模块是上游静态对照，不能冒充该 image 的完整运行证据。

本轮推荐直接评审并批准一个明确披露的 **derived PR-Agent runtime**：最小补丁为给 `sort_files_by_main_languages()` 增加显式的 `preserve_all_files`/等价 provider capability，默认保持现有过滤；在 `get_pr_diff()`、`get_pr_diff_multiple_patchs()` 及第三个 multi-diff 调用点传入该 capability，使 plain-diff 保留每一个已解析的 `FilePatchInfo`，但继续执行路径安全检查、patch 解析、hunk 规范化和 patch-only 模式。不得修改 GitHub provider 的 `is_valid_file`/`bad_extensions` 产品策略。未来官方 release 若提供等价修复，可替换该 derived runtime，但不作为本轮实施前置。

derived runtime 只携带上述最小多文件补丁，生成并固定新的 OCI image digest，且不能声称 official provider conformance。workflow 必须显式使用 `provider=plain-diff-derived`，并把 source commit、patch SHA-256、image digest 写入同一身份记录；`--diff-file`、scope receipt、Publisher、Coverage 和 fail-closed 判据保持不变。实现前必须在架构 Spec §7.3 增加该 provider 资格例外，并以最小 ADR 记录 runtime 来源、补丁边界、回退期限和替换条件；PRD 不需要改动。

### Workflow Spec §7.3 与 ADR 的最小 delta

| 位置 | 受控变化 | 不变的门禁 |
| --- | --- | --- |
| Reviewer identity | 在保留 `PR_AGENT` 选择的前提下，允许同一 reviewer 的 `provider=plain-diff-derived` runtime identity；记录 `runtimeKind=derived`、upstream source commit、patch SHA-256、OCI image digest。 | 不新增 reviewer、模型或凭证来源；GitHub provider 的过滤策略不变。 |
| Scope receipt | 将上述四个 runtime 字段与 repository、PR、base/head/merge-base、diff SHA-256/bytes、run/attempt 绑定。 | immutable diff、原始路径和 exact-head 校验不变。 |
| Native Review receipt | Publisher 回执必须回读并逐字段匹配 scope receipt 的 runtime identity，且声明 derived provenance。 | 同一 run/attempt、同一 head、同一 provider、结构化输出和 thread resolution 要求不变。 |
| Coverage validator | 仅当 `provider=plain-diff-derived` 且 runtime/source/patch/image 四字段与 scope、Review receipt 完全相等时，才允许进入既有 `complete` 判定。 | publisher job 成功、空输出、metadata-only、旧 head、缺字段或 mismatch 仍失败；required check 名称和 merge authority 不变。 |
| ADR / rollback | 记录上游 tag/commit、最小补丁文件与摘要、构建 provenance、image digest、负责人、到期/替换条件；任何校验失败回退官方 image 并保持 Coverage failure。 | 不改 PRD、漏洞扫描策略或 waiver 语义。 |

没有已验证的官方配置开关可以关闭 `pnpm-lock.yaml` 过滤；`--diff-file` 已存在且本次失败证明仅启用该入口不足。替代整个 provider 或接受 filtered-filename metadata 都扩大了信任边界，列为拒绝方案。

外部 handoff 中的 native source trace 直接加载 pinned image 回读的 `language_handler.py` 函数（source SHA-256 `37453385f735cc3e14cbe531a5768e82ad0ce9bd583e97652adbe32cb4d94637`）：`pnpm-lock.yaml` 与 `nested/pnpm-lock.yaml` 的 `is_valid_file` 均为 `False`，排序/过滤后 lockfile-only 保留 0 个文件，mixed 仅保留 `src/qs.ts`，对应模型输入分别为 0 和 21 bytes。该 trace 不导入或修改仓库代码，也不外发模型请求；上游 `v0.47.0` 的 `PlainDiffGitProvider` 与 `pr_processing` 只作为静态调用链证据。

实现后若任一身份、字节或输出校验失败，回退到当前固定官方 image 并让 Coverage 保持失败；不得回退到允许合并的 waiver。负例必须覆盖 root/nested lockfile-only、mixed diff、空文件、缺失文件、截断、非法 unified diff、路径穿越、旧 head、错误 run/attempt、provider/image/patch SHA 不匹配，以及模型未调用和 receipt 缺失。

## 有界提案

在完成 plain-diff 故障诊断后，本轮接受以下受控路径：

- 经正式批准的最小 derived runtime 修复，端到端证明输入文件、container 路径、CLI 解析、provider 模式、输出传输和 receipt 绑定均未丢失，并显式披露其非官方身份。官方等价修复只作为未来替换条件。

任何获批修复都必须：

1. 获取 workflow 已认证的 exact head 与 merge-base 对应的 immutable GitHub PR diff；
2. 在不改名路径、不改 hunk 的前提下，将保持字节不变的 unified diff 写入短生命周期 runner 文件；
3. derived 路径必须固定新的 digest 并使用 `plain-diff-derived` provider identity，不得混称 official conformance；未来替换为官方 runtime 时重新执行同一身份核验；
4. 用相同的 PR、head、run、attempt、merge-base、diff SHA-256、provider pin 和 model identity 记录 native review 结果及 token decision log；
5. 通过现有受信 Publisher 发布 findings，并原样使用现有专用 Coverage publisher；
6. 在 diff 为空、文件缺失或截断、CLI 输出 malformed、receipt identity 不一致，或 head/run/attempt/provider 不匹配时 fail closed。

兼容路径不得改变 model instructions、findings 语义、Review thread 锚定、Coverage 判定、required checks、扫描策略或 merge authority，也不得把上游 #3806 增加的 filtered-filename metadata 当作内容覆盖。

## 拒绝的捷径

- 重命名 `pnpm-lock.yaml`、填充 diff 或加入 synthetic source lines；
- 将 `PR-Agent Publish Review` 成功、空 Review、advisory scan 或 local fixture 当作 `Automated Review Coverage` 成功；
- 通过仓库配置修改 `is_valid_file`、修改 `bad_extensions` 或削弱 Coverage validator；
- 使用未 pin 的 fork/private image 或其他 provider，却声称符合 official-provider；
- 更新 `main` 或替换 #1296 head，使旧 receipt 看起来是当前结果。

## 合同映射

| 要求 | 现有权威 | 批准后的证明 |
| --- | --- | --- |
| 完整 immutable input | Workflow Spec §7.3；#1304 AC-1/2 | exact diff bytes、merge-base、SHA-256，以及 root/nested/mixed cases |
| Runtime identity | Workflow Spec §7.3 proposed delta | `plain-diff-derived`、source/patch/image identity、当前 `--diff-file` 调用和 plain-diff 故障回读 |
| Native review output | Workflow Spec §7.3 | 绑定 PR/head/run/attempt/provider 的同 run native receipt |
| Dedicated Coverage | `.github/scripts/review-coverage.mjs` | 不变的 validator 仅对匹配 receipt 返回 `complete` |
| Fail-closed | Workflow Spec §7.2/§7.3 | empty/omitted/truncated/malformed/old-head/mismatch 负例 |
| Merge authority | Workflow Spec §7.2/§7.3 | current-head CI、Issue、Readiness、Human、Coverage、零线程和 CODEOWNER |

## 批准后的验证计划

- 运行 focused deterministic tests：精确 diff 保持、root/nested lockfile-only、mixed diff、empty input、omission/truncation、malformed CLI output、stale head、provider/receipt mismatch；
- 在未改变的 #1296 head `85ccd983043d164b8ed74981cfc5fd61d18fd953` 上执行 native hosted run，使 model-request evidence、Review receipt 和 Coverage 绑定同一 run/attempt；
- 执行独立 `$code-review` 与 `$ponytail-review`、workflow-policy 和 Coverage tests，以及 Node 24/pnpm 11 frozen validation；
- 回读全部 hash、check conclusion、零未解决线程、CODEOWNER approval、Draft/Ready 状态及 `autoMergeRequest`。本提案不合并。

## 审批门

本提案已可交 maintainer/review-infrastructure 做合同评审。在批准前，Issue #1304 保持 `needs-triage`，#1296 保持 Draft 且关闭 auto-merge，不授权任何 provider/workflow 实现。
