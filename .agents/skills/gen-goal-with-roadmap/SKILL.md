---
name: gen-goal-with-roadmap
description: Generate a bounded, Roadmap-aware Coordinator Goal from live repository state.
disable-model-invocation: true
---

# Generate a Goal with Roadmap

Use this skill only when the user explicitly invokes `$gen-goal-with-roadmap`. It is a read-only planning entry point. It discovers the current repository state and emits either a short list of candidate invocations or one complete Coordinator Goal instruction. It does not create a Goal, start a subagent, edit an Issue, mutate a Project, create a branch, create a worktree, or send a notification.

The repository's GitHub Issues, native dependencies, pull requests, checks, branches, linked worktrees and Project fields are the authoritative state. Conversation text and local cache are context only. Do not infer ownership, completion, dates or permission from an old snapshot.

## Core vocabulary

- **Snapshot**: the immutable set of Issues selected for one Goal generation. Newly discovered or newly unblocked work is outside the snapshot.
- **Frontier**: an open implementation Issue whose native blockers are complete and which has no observable active owner, branch, worktree or PR conflict.
- **Lane**: one primary Issue, one worktree, one branch, one implementation owner, one PR and one verification path.
- **Coordinator**: the single owner of the snapshot, dependency checks, lane order, shared integration and terminal readback.
- **Approval-ready**: the current PR head has all applicable automated gates and review conversations complete, with only the repository's required human action remaining. It is evidence, not approval.
- **Terminal proof**: current readback accounts for every snapshot lane as Delivered or explicitly Human-retired.

## No-reference mode

When the user invokes the skill without Issue or Map references:

1. Read open `wayfinder:map` Issues, implementation Issues, native dependencies, milestones, Project fields, active PRs, assignees, branches and linked worktrees.
2. Exclude closed, blocked, ambiguous, actively owned, or scope-conflicting work. A clean worktree does not release ownership.
3. Rank eligible candidates deterministically: explicit Map focus in the current request, milestone risk, number of downstream Issues that would enter the frontier, external dependency risk, target date, then Issue number.
4. Emit at most three candidates. Each candidate must include its Issue or Map references and a complete explicit follow-up invocation such as `$gen-goal-with-roadmap #123 #124`.
5. Stop. Do not generate or execute a Goal from a bare selection such as `1`, `A`, or a title.

If no candidate is eligible, report the exact missing or blocking evidence and stop.

## Explicit-reference mode

When the user supplies a Map, Issue references, or both:

1. Resolve every reference against live GitHub state and classify it as a Map or implementation Issue. A bare number is not enough when the live object is ambiguous.
2. Validate parent/Map relationships, native dependency direction, open state, milestone scope, active PR/worktree ownership and required acceptance criteria.
3. Reject the whole request when any reference is ambiguous, belongs to a different Map, is blocked, is already actively owned, or requires an unapproved scope expansion. Report the exact reason and the live evidence used.
4. Freeze only the eligible frontier as the snapshot. Do not add newly unlocked work during execution.
5. Emit exactly one Coordinator Goal instruction containing the snapshot, lanes, queue order, gates, handoff rules, and terminal proof. Do not create or start the Goal.

## Generated Coordinator Goal contract

The generated Goal must contain the following rules in concise form:

- Re-read every selected Issue, dependency, PR, branch and worktree immediately before edits. If the snapshot changed, stop the affected lane and request a new explicit generation.
- Assign one lane per implementation owner. A lane declares its primary Issue, stable AC IDs, worktree, branch, base SHA, file/resource boundary, validation entry and expected PR.
- Keep shared entrypoints, lockfiles, deployment configuration, integration branches and final readback under Coordinator ownership. An implementation owner cannot claim a shared resource already owned by another lane.
- Maintain an explicit ownership ledger. Idle, timeout or process failure does not release ownership. Only a handoff containing outgoing/incoming owner, current exact head, completed ACs, remaining work, blockers, next action and evidence pointers transfers it.
- Keep retries finite and tied to a stable failure fingerprint. Exhausted retries become a blocker with a concrete recovery condition.
- Treat scope drift, contract conflict, missing authority, protected paths and unavailable credentials as blockers. Do not create Issues, dependencies, waivers or architecture decisions to make progress.
- Use the four externally visible stages: `Ready to implement`, `Implemented`, `Integrated`, and `Accepted`. Each transition requires evidence bound to the current exact head SHA.
- `Integrated` requires one combined version to start and one agreed vertical journey to execute. `Accepted` additionally requires current artifact identity, environment, commands, result, limitations and required human gates.
- Use an independent Verifier for the real entrypoint or user journey. The Verifier reports pass, failure, limitation or missing evidence and does not modify implementation or self-approve.
- Treat human review, validation and approval as verified waits when all Agent work is complete. Continue independent lanes and do not call an expected wait a blocker.
- At termination, re-read the current Issue, native dependencies, PR, checks, merge SHA, post-merge checks, worktree/branch cleanup and relevant Project fields. Summarize Delivered and Human-retired lanes separately.

The Goal may use repository-approved GitHub and local tooling during execution, but the generated text must not contain credentials, personal user IDs, private machine paths, raw transcripts, or instructions tied to one operator's private notification setup.

## Read-only and safety rules

- Generation has no side effects. It must not write GitHub, Project, Git, Goal, worktree, filesystem or notification state.
- Do not treat local `SESSION_BOARD.md` or `CONTEXT.md` as authority; use them only as handoff hints and reconcile them against live GitHub and Git state.
- Do not reuse evidence from an old head, old environment, closed Issue, stale Project snapshot or previous Goal.
- Do not widen the snapshot because a lane discovers useful follow-up work. Record the discovery for a later explicit invocation.
- Do not replace native GitHub dependencies or existing PR gates with a second graph, database, daemon, scheduler or lease service.
- Do not encode a personal notification provider, alias, user ID, credential path, local absolute path or machine-specific command in this skill or its generated Goal.

## Validation of generated output

Before returning output, check that:

1. No-reference mode contains zero to three complete follow-up invocations and no Goal execution instructions.
2. Explicit-reference mode contains exactly one immutable snapshot and one Coordinator Goal instruction.
3. Every lane has one primary Issue, owner, worktree, branch, base/head identity, file/resource boundary and verification entry.
4. Every dependency and exclusion is backed by live evidence; missing evidence is a blocker.
5. The output contains the stage gates, exact-head rule, independent Verifier, handoff rule, finite retry rule and terminal proof.
6. The output contains no credentials, personal identities, private notification workflow, raw session text or machine-specific paths.

The highest test seam is skill output: live-state fixtures in, bounded candidates or one complete Goal instruction out. Tests assert ranking, rejection, snapshot freezing, lane ownership, read-only behavior and generated contract content; they do not test model reasoning or a private notification channel.
