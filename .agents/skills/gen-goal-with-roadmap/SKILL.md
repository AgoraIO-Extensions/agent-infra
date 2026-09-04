---
name: gen-goal-with-roadmap
description: Generate one bounded coordinator Goal from live Roadmap state.
---

# Generate Goal With Roadmap

Generate text only. This skill reads GitHub and Git state, then emits either
candidate invocations or one copy-ready coordinator Goal. It does not create a
Goal, edit GitHub, change Git state, or send WeCom messages.

Use four terms consistently:

- **snapshot**: the immutable Issue set selected when the Goal is generated.
- **lane**: one primary Issue, worktree, branch, subagent, and PR ownership chain.
- **approval-ready**: the exact PR head has every Review thread resolved, all
  required CI and automated Review gates successful, no blocking review
  decision, and only human Approve remains.
- **terminal proof**: current readback accounts for every snapshot lane as
  Delivered or Human-retired.

## 1. Read Live State

Read the repository's `AGENTS.md`, Issue-tracker guidance, and AI-led development
workflow Spec. Infer the GitHub repository from the current checkout.

Using read-only GitHub and Git operations, collect:

- default branch and current remote head;
- open Wayfinder Maps and their sub-issue hierarchy;
- native Issue dependencies, state reason, labels, assignees, and Milestone;
- linked and open PRs with their current head and review/check state;
- Project Status, Start date, Target date, and parent/Map membership;
- local and remote branches plus linked worktrees;
- current-session execution ownership when the active environment exposes a
  reliable Issue association.

Resolve a bare `#<number>` as the repository guidance requires before
classifying it as a Map or implementation Issue. Treat unavailable or
contradictory authority as a bounded rejection, not as an assumption.

Completion criterion: every fact used for selection comes from current
readback, and this skill has made no external or Git mutation.

## 2. Select A Snapshot

### No Issue References

Build coherent candidate snapshots from implementation Issues in the open Maps.
An eligible Issue has the repository's complete Problem, Scope, acceptance,
validation, and blocker contract. Exclude planning, grilling, research,
external-resource preparation, closed, not-planned, malformed, blocked,
cross-Map, duplicated, or observably active work. An Issue assigned to the
current operator may remain a candidate only when no active PR, branch,
worktree, or reliably associated execution already owns it. Do not claim
cross-session Goal uniqueness when the environment cannot prove that mapping.

Rank candidates deterministically by:

1. the Map explicitly in focus in the current conversation;
2. overdue or near-term Milestone risk;
3. number of downstream Issues unblocked;
4. external human-dependency risk;
5. Target date;
6. Issue number as the final tie-breaker.

Show at most three candidates. For each, show its Map, lane Issues, why it is
next, completion shape, and main risk. End each candidate with the complete
follow-up invocation, for example:

```text
$gen-goal-with-roadmap #144 #351 #344
```

Then stop. A user-invoked skill must be invoked again; a later bare choice such
as `A` or `1` is not a continuation.

Completion criterion: zero to three ranked candidates are shown, every shown
lane is currently eligible, every candidate has a complete follow-up
invocation, no Goal instruction is emitted, and no state is changed.

### Explicit Issue References

Accept one Map, explicit implementation Issues, or one Map plus Issues.

- Map only: snapshot all currently eligible frontier Issues beneath that Map.
- Issues only: snapshot exactly the referenced Issues when all are eligible.
- Map plus Issues: snapshot exactly the referenced descendants when all are
  eligible.

Reject multiple Maps, cross-Map membership, unresolved planning tickets, or an
empty eligible result. Explicit Issue selection is atomic: one invalid or
conflicting reference rejects the whole invocation instead of filtering that
Issue out. A linked worktree whose path or branch identifies an Issue owns that
Issue until the worktree is removed; its clean or idle appearance is not a
release signal. Preserve native serial dependencies; only mutually independent
Issues become parallel lanes. Freeze the resulting Issue numbers: newly
discovered or newly unblocked work belongs to a later invocation.

Completion criterion: one non-empty snapshot is fully classified, every lane
has one primary Issue and no conflicting observable owner, and no state is
changed.

## 3. Emit One Coordinator Goal

Output exactly one copy-ready Goal instruction. Populate concrete repository,
Map, snapshot Issue, base-head, ownership, Project, and validation facts from
the readback. The Goal must contain the following contract.

### Objective And Ownership

- Complete only the frozen snapshot.
- Keep one primary Issue, worktree, branch, subagent, and PR per lane.
- Let the root coordinator own DAG revalidation, shared integration, Project
  writes, WeCom notifications, and terminal proof.
- Use available subagent slots for independent lanes and keep excess lanes in
  the same fixed queue. Reuse a released slot; do not create another Goal.
- Give every worker explicit file or module ownership and state that other work
  is concurrent and must be preserved.
- Run lanes concurrently only after their file or module ownership is disjoint.
  Keep overlapping lanes serialized in the same fixed queue.

### Start Gate And Roadmap

Before edits, re-read every snapshot Issue, dependency, assignee, active PR,
branch, worktree, Project item, and the current default-branch head. A changed
or conflicting lane becomes a human-intervention lane; it is not silently
removed or replaced.

For every accepted lane, the coordinator must:

1. ensure the Issue and relevant ancestors are present in the Project;
2. set the selected item and affected open capability parent/Map to
   `In Progress`;
3. record actual Start;
4. inherit a missing Milestone or Target from the nearest scheduled capability
   parent while preserving an existing human forecast;
5. read back every effective field before implementation begins.

Open Target is a human forecast. Start becomes actual start. Delivered or
Human-retired sets the lane Project Status to `Done` and Target to actual
terminal time. Parent/Map Start is the earliest reliable actual descendant
start. When older execution has no reliable timestamp and the existing Start is
still in the future, use the current Goal's actual start rather than inventing
earlier history or blocking the lane. After every required descendant
terminates, recompute the ancestor Status from those facts and set its Target to
the latest actual terminal time; preserve a non-terminal ancestor when work
remains or retirement changes its dependency route. Read back the effective
terminal projection.

### Scope Control

The snapshot never expands. Finish accepted work inside its existing Issue
contract. When correct work requires a new Issue, requirement, permission,
credential, or protected decision, pause that lane and request human
intervention. Leave newly unlocked work for the next generated Goal.

### Review And Approval

Each lane runs repository validation and the required current-head Review
process. Resolve all actionable Review threads and rerun affected validation
before checking approval-ready.

When one PR becomes approval-ready, use `$wecom` to notify the user-local alias
`me`. Resolve the alias first. Send one notification per `PR + head SHA`, with
the Map, Issue, PR, head, passed gates, and requested Approve; include no
credentials or source content. A new head must become approval-ready again
before another notification. Continue every independent lane.

Human Approve is a verified wait. Poll the same PR with increasing intervals,
roughly 30 seconds, 60 seconds, 2 minutes, then 5 minutes. Approval latency
keeps the Goal active and never counts toward blocked status.

### Intervention

Use `$wecom` only when the coordinator cannot continue inside current scope and
authority: requirements conflict, missing permission or credential, necessary
new Issue, exhausted repair budget, persistent Project readback failure, or an
explicit approval rejection.

Deduplicate by `Goal + stable reason`. Include the affected Map/Issue/PR/head,
the stable reason, attempted recovery, and the decision required. Pause that
lane and continue independent lanes. When the same true human blocker remains
unchanged for three consecutive Goal turns after other lanes finish, mark the
Goal blocked with the exact recovery condition. Resume this Goal after human
resolution.

### Terminal Proof

Account for every snapshot lane as exactly one of:

- **Delivered**: primary PR merged, Issue closed as completed, PR-head gates and
  Review evidence verified before merge, post-merge CI successful on the
  exact merge SHA, required merged-PR Git cleanup delegated and verified, and
  effective Project terminal fields read back.
- **Human-retired**: the user explicitly retired the lane in this conversation
  or durable GitHub state, the Issue is not-planned or wontfix, resulting
  dependency state is read back, and effective Project terminal fields are
  read back.

The Agent cannot infer Human-retired from failure, inactivity, or missing
approval. Complete the Goal only when terminal proof covers the full snapshot.
The final report separates Delivered and Human-retired lanes and cites their
current evidence.

Completion criterion: the response contains exactly one Goal instruction with
the full snapshot, lane ownership, start gate, Roadmap rules, fixed scope,
approval-ready notification, verified waits, intervention policy, and terminal
proof; the response contains no secrets or personal userid; generation changed
no external or Git state.
