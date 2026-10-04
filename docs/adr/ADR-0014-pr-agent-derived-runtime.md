# ADR-0014：PR-Agent lockfile plain-diff 的 derived runtime

状态：Proposed（未批准，不是当前生产配置）  
日期：2026-10-04  
关联：Issue #1304、Workflow Spec §6.3、§7.3、§7.3.1

## 决策

为恢复 lockfile-only plain-diff 的原生 Coverage，允许一个短期、明确披露的
`plain-diff-derived` runtime。它只携带经批准的 plain-diff 文件保留 capability；GitHub provider
的 `is_valid_file`/`bad_extensions` 策略不变。该 runtime 不得声称 official provider conformance，
也不是新的 Automated Reviewer。

生产启用必须在本 ADR 与 Workflow Spec 对应条款获批后进行；当前分支提交不改变 `main`、image、
workflow、Publisher、Coverage validator 或 required checks。

## 问题边界与最小补丁

固定 provider 会在模型输入前拒绝 root/nested `pnpm-lock.yaml`。plain-diff 的最小补丁是让
`sort_files_by_main_languages()` 接受显式 `preserve_all_files` capability，默认仍过滤；三个
plain-diff diff-processing 调用点传入该 capability。路径安全检查、unified patch 解析、hunk
规范化、patch-only 和 token cap 保持原语义。

不允许重命名或 padding lockfile、修改 GitHub provider 全局过滤、接受 metadata-only coverage、
使用 Publisher 成功替代 Coverage、加入 waiver、引入第二 reviewer、改变模型或凭证来源。

## 固定身份

启用时必须在 scope receipt、native Review receipt 和 Coverage metadata 中逐字段绑定：

- `reviewer=pr-agent`；`provider=plain-diff-derived`；`runtimeKind=derived`；
- 不可变的上游 source commit（tag 只能作为辅助别名，不能作为身份值）；
- 最小补丁文件清单及 patch SHA-256；
- OCI image digest；
- repository、PR、base/head/merge-base、diff SHA-256/bytes、workflow run/attempt、Analysis job；
- 固定模板、TypeScript recorder 版本和生效 token cap。

任一字段缺失、截断、摘要不匹配、source/patch/image 不是批准组合，或 provider 与 runtimeKind
不一致，均使用 `review-output-invalid`/provider mismatch 拒绝，不可进入 `complete`。

## Recorder、Publisher 与 Coverage

recorder 继续是 job-local TypeScript HTTP 边界，接收实际模型请求、原样转发并记录有限 metadata；
不得在 derived image 中加入 Python recorder、常驻服务、通用协议或第二调度器。输入、响应和
hunk 核对遵循 Workflow Spec §7.3.1 的既有清单及最多 3 个 chunk 约束。

Publisher 仍只发布结构化 Review；check-only Coverage App 仍独立发布 required Check。两者必须
回读同一 run/attempt、head、receipt 和 derived identity。Publisher job 成功、空 Review、旧 head、
filtered-filename metadata、部分响应或另一个 run 均不能通过 Coverage。

## 安全边界与回退

`--diff-file` 输入保持原始路径和字节；不加载 PR 配置、attributes 或外部 diff。Source、patch、
image、template、transport 和 recorder 版本都必须可回读。GitHub 写 Token 不进入 recorder 或
模型请求；普通用户正文和 Secret 不进入持久 metadata。

任何 identity、输入、输出、receipt 或 current-head 校验失败都使本次 run 失败；受控配置回滚
才可在后续 run 回退到官方 image，且不得在同一 run 更换 identity 或重跑模型绕过预算。到期或
官方等价修复发布后，维护者必须重新固定 source/patch/image identity，
完成同一 hosted 正负验证并提交替换评审；禁止无审查替换 digest。

## 验证与退出条件

必须覆盖 root/nested lockfile-only、mixed diff、空/缺失/截断/非法 unified diff、路径穿越、旧
head、错误 run/attempt、provider/source/patch/image mismatch、模型未调用、部分响应和 receipt
缺失；必须回读同一 run/attempt 的 Review receipt、Coverage Check、0 unresolved threads、CODEOWNER
与 required checks。验证只接受实际固定 runtime 请求格式，不接受手写 fixture 冒充。

实验性 delta PR 保持 Draft 且关闭 auto-merge；未来合并型实现 PR 必须非 Draft、exact-head gates
通过、0 unresolved threads，并在真实人工审批后启用 squash auto-merge。未完成前不关闭 #1296/#1295。

## 维护责任

本 ADR 由 review-infrastructure owner 维护。#1324 独占 TypeScript recorder、Git inventory 和
shadow；最终 shared workflow identity/coverage 串行接收本 ADR 字段。Connection、Host/Grant/Driver
wire、附件探针和无关业务代码不属于本 ADR。
