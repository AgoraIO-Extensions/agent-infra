# OpenCode v1.18.30 Source Review Packet

## Decision Status

This packet is an unapproved review input for #957. It does not change the
OpenCode runtime pin, build or publish a derived artifact, enable a private
lane, or close #483, #929, or #930. The patch file is a candidate source
change only; it has not been applied to the upstream checkout or this
repository, and it has not been built.

The repository Spec change in this PR makes the sequence explicit: before the
change is effective, no derived artifact may be built. After it is effective,
an isolated candidate build may produce evidence. Each target's actual bytes,
hash, native verification, maintenance owner, and exit path still require a
separate CODEOWNER approval before publication or enablement.

## Frozen Inputs

- Upstream repository: `anomalyco/opencode`
- Upstream tag: `v1.18.30`
- Upstream commit: `3104c1428ec91f809e5ab86631300de41eb6952e`
- Upstream commit subject: `release: v1.18.30`
- Build package: `packages/opencode/package.json`, version `1.18.30`
- Dependency lock: upstream `bun.lock`, SHA-256
  `9a6c2352e847d212485867812d4aa97a6b067ca7d4463ef9aa263341fb7a78bf`
- Root package manifest SHA-256:
  `b1aa48ddbe8074072e308daf98e30eba2596fd2ad479bbbe061d04504b7a757e`
- OpenCode package manifest SHA-256:
  `8e966e28bc7511058a782b2c21de831d24daa60af1ef2ada005a603acb017465`
- Upstream `LICENSE` SHA-256:
  `625f0f619133f89bbbb2abe37369613dfa1885eba1e50d02170deb62bb42cb6b`
- The pinned upstream tree has no `NOTICE` file. A repackaged artifact must
  add a generated NOTICE containing the upstream MIT license and all bundled
  dependency notices, then include its hash in the final approval packet.

The candidate patch is the exact unified diff in
`opencode-v1.18.30-effect-receipt.patch`. Its SHA-256 is
`210b06a3788146d3a6b8a2b2c703d7bcb8bb0832853ac2f9db4372460f7e4858`.
It adds a transport-agnostic receipt schema and validator. It deliberately
does not pretend that a schema alone proves a tool effect.

## Target Set

The target set is copied from the repository's pinned release declaration:

| Target | Official archive SHA-256 | Official executable SHA-256 |
| --- | --- | --- |
| `darwin-arm64` | `a5e43d6887386efc7d68ce49ae28e3bbdfdee3dfd1d7169b612c3ce67e53b1e8` | `2d0c9c339bb91046c6ea951c97664bc2f8a8eaca707f31fbfbb7bc73c4eddc62` |
| `linux-arm64-musl` | `295250c1676545a3da14ccd650b7118e64d4f33a5d884c6d7c8d79c753d8238d` | `581c68ed3c39bfc8ce60fcb20cc71f371e388c3f6d3a7ddd6f10a78a1d4128ab` |
| `linux-x64-musl` | `d313abe7ae6a68f54f7ca93b0f2672adc0d129b6075db4c1211d27b4864fffcb` | `2433b257165af0ac7fc4c42a638c5850e449f7973890269abe606fffde20a425` |

These are official artifact hashes, not hashes for the candidate patch. New
candidate hashes do not exist until the approved evidence phase permits an
isolated build.

## Private Protocol

The patch's `EffectReceipt` is a private Driver/native message, not a public
API or a second business fact schema. Every message carries the original
`sessionID`, `turnID`, `callID`, `executionID`, `generation`, `fence`,
`operationRef`, and `attemptRef`, plus a per-leaf `leafNonce`, monotonic
`sequence`, `target`, and `ackID`.

The required phase order is `intent -> permit -> started -> terminal`, where
terminal is exactly one of `completed`, `failed`, `cancelled`, or `unknown`.
`permit` is admission only. `started` is emitted only at the actual I/O or
process/client dispatch call. A rejected permission, validation failure, or
before hook cannot create `started` or a duration. Duplicate requests replay
the saved decision; a real retry receives a new leaf nonce. A lost terminal
ACK is recovered by reading the same attempt and is never repaired by
replaying a possibly effective write.

The driver must reject a message with a mismatched execution, generation,
fence, call, sequence, or target. File contents, credentials, model text, and
raw native errors are excluded; `errorCode` is a bounded classification only.

## Leaf Coverage

The following are the required insertion points against the frozen source.
The candidate patch does not claim these are already wired; each row remains
unverified until a later implementation patch and real artifact validation.

| Leaf/helper | Frozen source point | Receipt boundary | Status |
| --- | --- | --- | --- |
| Read stat and directory enumeration | `tool/read.ts:243-264` | intent/permit immediately before the filesystem call; terminal ACK after return | unimplemented in candidate patch |
| Read instruction, sample, attachment and line stream | `tool/read.ts:300-331` | one receipt per actual open/read/stream operation | unimplemented in candidate patch |
| Write existing-content read | `tool/write.ts:46-47` | read leaf, separate from write leaf | unimplemented in candidate patch |
| Write and format/BOM sync | `tool/write.ts:64-66` | write leaf starts at `writeWithDirs`; post-write formatting is a distinct leaf | unimplemented in candidate patch |
| Edit existence/stat/old-content read | `tool/edit.ts:90-126` | read leaves remain separate from write leaves | unimplemented in candidate patch |
| Edit write and post-processing | `tool/edit.ts:111-113`, `155-157` | write, format and event publication are independently classified | unimplemented in candidate patch |
| Apply patch writes, removes and moves | `tool/apply_patch.ts:226-247` | each filesystem mutation has its own nonce and terminal ACK | unimplemented in candidate patch |
| Shell process dispatch | `tool/shell.ts:342-350`, `484` | started at the child dispatch call, not at permission or spawn preparation | unimplemented in candidate patch |
| MCP/client dispatch and code mode | `tool/code-mode.ts:150` | started at client dispatch, with unknown on lost response | unimplemented in candidate patch |
| Wrapper success/error/cancel | `session/tools.ts:102-133`, `processor.ts:186-206` | outer errors cannot replace missing leaf receipts | unimplemented in candidate patch |

New helpers, delegated tools, retries, background actions, symlink or target
replacement races, and plugin-provided tools remain outside the claim until
they receive their own rows and evidence. The same tool ID across executions
does not satisfy this matrix.

## Launcher And Isolation

The proposed implementation keeps ACP stdio as the business protocol and
creates a separate per-native-process control channel in the Driver. On Linux
and macOS the launcher uses a private `0700` directory and a local
`SOCK_SEQPACKET` or equivalent authenticated socketpair. It passes only the
explicit endpoint to the trusted native process, closes every control
descriptor in the tool child before `exec`, and verifies peer credentials and
the original execution binding on every message.

The current OpenCode process can load configurable same-process plugins. A
private receipt lane must therefore fail closed when an untrusted plugin is
loaded, or move the receipt endpoint into a process that the plugin cannot
reach. A same-UID pathname, inherited environment token, ACP frame, model
setting, or ordinary callback is not isolation evidence. Negative tests must
prove that a plugin and a tool child cannot read, close, forge, replay, or
delay a receipt endpoint. Stop, revoke, and generation changes close new
permits before draining in-flight control requests.

## Candidate Build And Validation

After the Spec timing correction is effective and only in an isolated
verification environment, the proposed command is `bun install --frozen-lockfile`
followed by the pinned package typecheck/build and the native harness for each
target. The evidence packet must record the source tree SHA, patch SHA, lock
SHA, toolchain/container digest, command, target, output SHA, and attempt.
No runtime download, runtime compilation, publish, or enablement is allowed.

The harness must exercise, per target and per leaf: permit-before-zero-action,
real read/edit/write and process/client dispatch, validation rejection,
write-then-error, cancellation, lost terminal ACK, restart of the original
Session, call ID reuse, cross-Execution and cross-principal mismatch,
symlink/target replacement, plugin access, child FD inheritance, forged or
replayed receipts, and sensitive sentinel redaction. It must read the durable
original attempt and prove that an unknown result is not retried.

Fixture-only or fake-driver results can validate message parsing and negative
state transitions, but cannot qualify a target artifact or satisfy #483's
real Provider/Connection acceptance.

## Ownership And Exit

The packet intentionally leaves the long-term Runtime maintainer, security
upgrader, and release approver unnamed. No Issue assignee or prior document
approval is a substitute for an explicit human acceptance. Before enablement,
the owner must be named, the rollback artifact and rollback command must be
readable, and the exit condition must be demonstrated: the official artifact
passes the same leaf, isolation, recovery, and target coverage matrix.

Until those fields are filled and CODEOWNER approves the exact target bytes,
the OpenCode native lane remains unavailable and #929/#930/#483 retain their
original open acceptance criteria.
