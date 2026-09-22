---
name: coordination-harness
description: Start a bounded local AI coding coordination session from an Issue and worktree snapshot.
disable-model-invocation: true
---

# Coordination Harness POC

Use this local-only entry point for a bounded milestone slice. Read the current primary Issue, native dependencies, associated PR/CI state, and worktree snapshot before starting. The GitHub Issue, PR, CI and Project remain authoritative; `SESSION_BOARD.md`, `CONTEXT.md`, and `session.json` are disposable handoff caches.

The start input is JSON with `issue`, `worktree`, and `roles` fields. `issue.acceptanceCriteria` must contain unique `AC-N` identifiers. `worktree` must include the current exact `baseSha` and `headSha`. The command writes only to the output directory supplied by the caller:

```bash
node .agents/skills/coordination-harness/scripts/coordination.mjs start input.json .local-coordination/issue-<number>
```

The command enters `Ready to implement` only when the Issue contract, dependencies, and owner/writer/verifier assignments are complete. Otherwise it returns `Blocked` with a stable blocker code. It never writes GitHub state, releases ownership on timeout, or infers missing local changes.
