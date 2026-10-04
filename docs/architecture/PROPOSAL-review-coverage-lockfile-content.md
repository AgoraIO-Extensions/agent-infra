# Proposed: native review coverage for lockfile-only diffs

Status: **Proposed — not approved and not implementation authority**  
Owner: review-infrastructure lane for Issue #1304  
Primary: [Issue #1304](https://github.com/AgoraIO-Extensions/agent-infra/issues/1304)  
Affected consumer: #1296 / primary #1295  
Review base: `8327fbf911cc2e6761610ac86772c4969bf0771c`

## Decision requested

Approve or reject the bounded compatibility boundary below. No provider, workflow, Publisher, Coverage, or vulnerability-policy code may be changed from this proposal alone.

## Evidence and current contract

The pinned official PR-Agent GitHub-provider image filters the basename `pnpm-lock.yaml` in `is_valid_file` before model invocation. The behavior was reproduced for root and nested lockfiles using the exact source layer recorded in Issue #1304. Upstream release `v0.47.0` and commit `9ed605cc992f18663d2527c35cf990813fba6654` retain the filter; upstream PR #3806 only reports filtered filenames as metadata and does not send lockfile content.

The current repository workflow already invokes the pinned official CLI through `--diff-file` plain-diff mode. It writes the certified diff to `.pr-agent-review-input.diff` and passes that path into the container; adding another diff-file entry point is therefore not the proposed fix. The current failure is later in the official plain-diff path: on #1312 head `255df29f822c8e356356d409d66f628fc6b24466`, run `37182555582` attempt `1` recorded a complete 1184-byte diff (`diffSha256=a1379d721574a144796d2453a1585f3ac0fc5bbfcd29b66c6aef16a205e2e6ff`), and the runtime logged 2,544 tokens below the 300,000-token limit, but then emitted `Empty diff for PR: local_diff`. No valid Review receipt was produced and Coverage remained `review-run-failed`. The log confirms the container entered `PlainDiffGitProvider`; the remaining diagnosis must cover file visibility/content transfer, CLI argument parsing, provider diff loading, and the output/receipt path.

Workflow Spec §7.3 therefore remains the authority: exact current-head provider evidence, deterministic token decision log, same-run native Review publication receipt, dedicated check-only Coverage publication, and fail-closed handling for missing, invalid, truncated, old-head, or provider-mismatched output.

## Proposed controlled boundary

After the plain-diff failure is diagnosed, accept only one of these bounded repairs:

- an official upstream fix to the pinned plain-diff/local-diff behavior; or
- a formally approved, minimal repository-side repair that proves the existing input file, container path, CLI parsing, provider mode, output transfer, and receipt binding end to end.

Any approved repair must:

1. obtain the immutable GitHub PR diff for the exact head and merge-base already certified by the workflow;
2. write that byte-preserving unified diff to a short-lived runner file without renaming paths or changing hunks;
3. preserve the existing pinned official PR-Agent runtime and `--diff-file` plain-diff entry (or use the reviewed upstream equivalent);
4. record the native review result and token decision log with the same PR, head, run, attempt, merge-base, diff SHA-256, provider pin, and model identity;
5. publish findings through the existing trusted Publisher and use the existing dedicated Coverage publisher unchanged;
6. fail closed when the diff is empty, any file is omitted or truncated, the CLI output is malformed, the receipt identity differs, or the head/run/attempt/provider does not match.

The compatibility path must not alter model instructions, findings semantics, Review thread anchoring, Coverage verdicts, required checks, scan policy, or merge authority. It must not accept the filtered-filename metadata added by upstream #3806 as content coverage.

## Rejected shortcuts

- Renaming `pnpm-lock.yaml`, padding the diff, or adding synthetic source lines.
- Accepting `PR-Agent Publish Review` success, an empty review, an advisory scan, or a local fixture as `Automated Review Coverage` success.
- Changing `is_valid_file` through repository config, changing `bad_extensions`, or weakening the Coverage validator.
- Using an unpinned fork/private image or a different provider while reporting official-provider compliance.
- Updating `main` or replacing the #1296 head to make an old receipt appear current.

## Contract mapping

| Requirement | Existing authority | Proposed proof after approval |
| --- | --- | --- |
| Complete immutable input | Workflow Spec §7.3; #1304 AC-1/2 | exact diff bytes, merge-base, SHA-256, root/nested/mixed cases |
| Official runtime | Workflow Spec §6.3/§7.3 | pinned image digest, current `--diff-file` invocation, and plain-diff failure readback |
| Native review output | Workflow Spec §7.3 | same-run native receipt bound to PR/head/run/attempt/provider |
| Dedicated Coverage | `.github/scripts/review-coverage.mjs` | unchanged validator returns `complete` only for matching receipt |
| Fail-closed | Workflow Spec §7.2/§7.3 | negative tests for empty/omitted/truncated/malformed/old-head/mismatch |
| Merge authority | Workflow Spec §7.2/§7.3 | current-head CI/Issue/Readiness/Human/Coverage, zero threads, CODEOWNER |

## Validation plan after approval

- Focused deterministic tests: exact diff preservation; root and nested lockfile-only; mixed lockfile/source; empty input; omission and truncation; malformed CLI output; stale head; provider and receipt mismatch.
- Native hosted run on unchanged #1296 head `85ccd983043d164b8ed74981cfc5fd61d18fd953`, with model-request evidence, Review receipt and Coverage all bound to one run/attempt.
- Independent `$code-review` and `$ponytail-review`; workflow-policy and Coverage tests; Node 24/pnpm 11 frozen validation.
- Read back all hashes, check conclusions, zero unresolved threads, CODEOWNER approval, Draft/Ready state and `autoMergeRequest`. Do not merge this proposal.

## Approval gate

This proposal is ready for maintainer/review-infrastructure contract review. Until approved, Issue #1304 remains `needs-triage`, #1296 remains Draft with auto-merge disabled, and no provider/workflow implementation is authorized.
