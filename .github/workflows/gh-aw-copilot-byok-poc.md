---
name: gh-aw Copilot BYOK Issue-to-PR POC
description: Create one reviewable draft PR from a fixed-operator manual Issue dispatch.
on:
  workflow_dispatch:
    inputs:
      item_number:
        description: Existing GitHub Issue number to implement.
        required: true
        type: string
  roles: [admin]
  status-comment: true
if: github.actor == 'LichKing-2234'
run-name: "Issue #${{ inputs.item_number }} | gh-aw-poc | dispatch"
concurrency:
  group: "gh-aw-poc-${{ inputs.item_number }}"
  cancel-in-progress: false
permissions:
  contents: read
  issues: read
  pull-requests: read
engine:
  id: copilot
  env:
    COPILOT_PROVIDER_BASE_URL: ${{ secrets.CODEX_RESPONSES_API_ENDPOINT }}
    COPILOT_PROVIDER_API_KEY: ${{ secrets.CODEX_API_KEY }}
    COPILOT_PROVIDER_TYPE: openai
    COPILOT_PROVIDER_WIRE_API: responses
model: ${{ secrets.CODEX_MODEL }}
network:
  allowed:
    - defaults
tools:
  edit:
  bash: true
safe-outputs:
  threat-detection: false
  create-pull-request:
    title-prefix: "[gh-aw POC] "
    labels: [gh-aw-poc]
    draft: true
    max: 1
    base-branch: main
    allowed-branches: ["gh-aw/poc-*"]
    fallback-as-issue: false
    auto-close-issue: false
    if-no-changes: error
    max-patch-files: 20
    max-patch-size: 512
    allowed-files: ["apps/**", "packages/**", "tests/**"]
    protected-files: fallback-to-issue
    github-token-for-extra-empty-commit: ${{ secrets.CODEX_GITHUB_TOKEN }}
timeout-minutes: 60
checkout:
  fetch-depth: 0
---

# gh-aw Copilot BYOK POC

Implement the existing GitHub Issue selected by `item_number` and open one draft pull request for human review.

Requirements:

1. Read `AGENTS.md`, the Issue title, body, and existing comments before changing files.
2. Treat the Issue as the specification. Stop without a pull request when it is incomplete, blocked, already implemented, or conflicts with repository guidance.
3. Make the smallest coherent change that satisfies the Issue. Do not modify protected workflow, policy, credential, dependency, generated, PRD, architecture, or Agent instruction files.
4. Run targeted tests first, then every repository validation required by `AGENTS.md` that is relevant and feasible in the runner.
5. Review the diff against both repository standards and the Issue before publication.
6. Use the `create_pull_request` safe-output tool exactly once only when the patch is non-empty and validation supports review.
7. Create a source branch matching `gh-aw/poc-*`. Keep the pull request in draft state and include test evidence, skipped checks, risks, and `Closes #${{ inputs.item_number }}`.
8. Never approve, merge, close the Issue, reveal credentials or endpoints, or claim session continuation after a retry.

POC limitation: threat detection is disabled because the existing endpoint is available only as a Secret and its hostname is not available for a static firewall allowlist. Human review and draft-only publication are mandatory.
