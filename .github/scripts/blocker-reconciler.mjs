import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  assertCanAddBlockers,
  BLOCKER_PUBLISH_TRIAGE_COMMENT,
  BLOCKER_REVIEW_COMMENT,
  blockerStatus,
  buildBlockerIdentityComment,
  buildBlockerStateComment,
  classifyDependentBlockers,
  hasTrustedBlockerReviewAck,
  hasTrustedBlockerIdentityAudit,
  hasTrustedWorkerDispatchAck,
  inspectBlockerGraph,
  isActionsCreatedBlockerIssue,
  isGitHubActionsBot,
  isTrustedActionsObject,
  isTrustedBlockerReviewComment,
  latestBlockerStateRecord,
  nativeDependencyDecision,
  parseBlockerProposalRecord,
  reconciliationIssueNumbers,
  replaceBlockedBy,
} from "./blocker-contract.mjs";
import {
  blockedByStateHash,
  buildAuthorizationRecordComment,
  executionContent,
  latestAuthorizationRecord,
  parseAuthorizationRecords,
  parseBlockedBy,
  transitionAuthorization,
} from "./worker-contract.mjs";

function labelsOf(issue) {
  return (issue?.labels ?? []).map((label) =>
    typeof label === "string" ? label : label.name,
  );
}

function bindWorkerTopology(state, repository, issueNumber, pullRequests, branchRefs) {
  const branchPrefix = `codex/issue-${issueNumber}-cycle-`;
  const canonical = {
    branches: branchRefs
      .filter((ref) => String(ref?.ref ?? "").startsWith(`refs/heads/${branchPrefix}`))
      .map((ref) => ({
        ref: ref.ref,
        sha: typeof ref.object?.sha === "string" ? ref.object.sha : null,
      }))
      .sort((left, right) => left.ref.localeCompare(right.ref)),
    pullRequests: pullRequests
      .filter((pullRequest) =>
        String(pullRequest?.head?.ref ?? "").startsWith(branchPrefix),
      )
      .map((pullRequest) => ({
        baseRef: pullRequest.base?.ref ?? null,
        draft: pullRequest.draft === true,
        headRef: pullRequest.head?.ref ?? null,
        headRepository: pullRequest.head?.repo?.full_name ?? null,
        headSha: pullRequest.head?.sha ?? null,
        mergedAt: pullRequest.merged_at ?? null,
        number: pullRequest.number,
        state: pullRequest.state ?? null,
      }))
      .sort((left, right) => left.number - right.number),
    repository,
  };
  return {
    ...state,
    signature: createHash("sha256")
      .update(
        JSON.stringify({
          blockerStateSignature: state.signature,
          workerTopology: canonical,
        }),
        "utf8",
      )
      .digest("hex"),
  };
}

function proposalIdentity(record) {
  return [
    record.sourceIssue,
    record.sourceCycle,
    record.executionContentHash,
    record.proposalId,
    record.digest,
  ].join(":");
}

function sameProposalSource(left, right) {
  return (
    left.sourceIssue === right.sourceIssue &&
    left.sourceCycle === right.sourceCycle &&
    left.executionContentHash === right.executionContentHash
  );
}

export function isRetiredBlockerProposal(record, blocker, authorization) {
  const current = authorization?.current;
  const contract = authorization?.contract;
  return Boolean(
    blocker?.state === "closed" &&
      blockerStatus(blocker) === "not_planned" &&
      current &&
      ["active", "paused"].includes(current.state) &&
      current.cycle > record?.sourceCycle &&
      current.executionContentHash === contract?.hash &&
      current.blockedByHash === contract?.blockedByHash &&
      !contract?.blockerNumbers?.includes(blocker.number),
  );
}

const UNEDITED_BLOCKER_QUERY = `
  query UneditedBlocker($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        id
        title
        body
        lastEditedAt
        author { login }
      }
    }
  }
`;

export function isUneditedActionsBlockerSnapshot(issue, live) {
  return Boolean(
    isActionsCreatedBlockerIssue(issue) &&
      issue.node_id &&
      live?.id === issue.node_id &&
      live.title === issue.title &&
      live.body === issue.body &&
      live.lastEditedAt === null &&
      live.author?.login === "github-actions",
  );
}

export function matchesRecoveryAuthorization(record, authorization) {
  const current = authorization?.current;
  const contract = authorization?.contract;
  return Boolean(
    current &&
      ["active", "paused"].includes(current.state) &&
      current.cycle === record?.sourceCycle &&
      current.executionContentHash === record?.executionContentHash &&
      current.executionContentHash === contract?.hash &&
      current.blockedByHash === contract?.blockedByHash,
  );
}

async function isUneditedActionsBlocker({ repository, issue, token, request }) {
  if (!isActionsCreatedBlockerIssue(issue) || !issue.node_id) return false;
  const [owner, name] = repository.split("/");
  const response = await request("/graphql", {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: UNEDITED_BLOCKER_QUERY,
      variables: { owner, name, number: issue.number },
    }),
  });
  return isUneditedActionsBlockerSnapshot(
    issue,
    response?.data?.repository?.issue,
  );
}

export function dependentReconciliationDecision({
  issue,
  state,
  latestRecord,
  dispatchAcknowledged = false,
}) {
  const labels = labelsOf(issue);
  const sameState = latestRecord?.signature === state.signature;
  if (issue?.state !== "open" || labels.includes("wontfix")) {
    return { addTriage: false, comment: false, dispatch: null };
  }
  const executable =
    labels.includes("ready-for-agent") &&
    !labels.some((label) =>
      ["needs-triage", "ready-for-human"].includes(label),
    );
  const operation =
    state.state === "triage"
      ? labels.includes("ready-for-agent")
        ? "triage"
        : null
      : executable
        ? state.state === "frontier"
          ? "evaluate"
          : "pause"
        : null;
  return {
    addTriage:
      state.state === "triage" && !labels.includes("needs-triage"),
    comment: !sameState,
    dispatch: operation && !dispatchAcknowledged
      ? {
          operation,
          reason: state.reason,
        }
      : null,
  };
}

async function githubRequest(
  apiPath,
  { token, allowNotFound = false, ...options } = {},
) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...options.headers,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const method = options.method ?? "GET";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let response;
    try {
      response = await fetch(`https://api.github.com${apiPath}`, {
        ...options,
        headers,
      });
    } catch (error) {
      if (method !== "GET" || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 250));
      continue;
    }
    if (allowNotFound && response.status === 404) return null;
    if (response.ok) {
      return response.status === 204 ? null : response.json();
    }
    if (
      method !== "GET" ||
      attempt === 3 ||
      ![429, 500, 502, 503, 504].includes(response.status)
    ) {
      throw new Error(`GitHub API ${method} request failed with ${response.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 250));
  }
  throw new Error(`GitHub API ${method} request failed`);
}

async function githubPaginate(apiPath, { token, request = githubRequest } = {}) {
  const values = [];
  for (let page = 1; page <= 20; page += 1) {
    const separator = apiPath.includes("?") ? "&" : "?";
    const batch = await request(
      `${apiPath}${separator}per_page=100&page=${page}`,
      { token },
    );
    values.push(...batch);
    if (batch.length < 100) return values;
  }
  throw new Error(`GitHub API pagination limit exceeded for ${apiPath}`);
}

async function addTriageLabel(repository, issueNumber, token, request) {
  await request(`/repos/${repository}/issues/${issueNumber}/labels`, {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ labels: ["needs-triage"] }),
  });
}

async function removeTriageLabel(repository, issueNumber, token, request) {
  await request(
    `/repos/${repository}/issues/${issueNumber}/labels/needs-triage`,
    { token, method: "DELETE", allowNotFound: true },
  );
}

export function hasSystemTriageEvidence({
  comments = [],
  events = [],
  requirePublisherFailure = false,
}) {
  const labelEvents = events
    .filter((event) => event?.label?.name === "needs-triage")
    .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
  const latest = labelEvents.at(-1);
  if (latest?.event !== "labeled" || !isGitHubActionsBot(latest.actor)) {
    return false;
  }
  if (!requirePublisherFailure) return true;
  return comments.some(
    (comment) =>
      isTrustedActionsObject(comment, { appendOnly: true }) &&
      comment.body === BLOCKER_PUBLISH_TRIAGE_COMMENT &&
      String(comment.created_at) >= String(latest.created_at),
  );
}

async function publishComment(repository, issueNumber, body, token, request) {
  await request(`/repos/${repository}/issues/${issueNumber}/comments`, {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
}

async function dispatchWorker(repository, issueNumber, state, operation, token, request) {
  await request(`/repos/${repository}/dispatches`, {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event_type: "codex-worker",
      client_payload: {
        issue_number: issueNumber,
        operation,
        reason: state.reason,
        blocker_state_signature: state.signature,
      },
    }),
  });
}

async function ensureReviewComment({
  repository,
  issueNumber,
  record,
  token,
  request,
  paginate,
}) {
  let comments = await paginate(
    `/repos/${repository}/issues/${issueNumber}/comments`,
    { token, request },
  );
  if (!comments.some((comment) => isTrustedBlockerReviewComment(comment))) {
    await publishComment(
      repository,
      issueNumber,
      BLOCKER_REVIEW_COMMENT,
      token,
      request,
    );
    comments = await paginate(
      `/repos/${repository}/issues/${issueNumber}/comments`,
      { token, request },
    );
  }
  if (hasTrustedBlockerReviewAck(comments, issueNumber, record)) return;
  await request(`/repos/${repository}/dispatches`, {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event_type: "claude-blocker-review",
      client_payload: { issue_number: issueNumber },
    }),
  });
}

async function reconcileNativeDependencies({
  repository,
  graph,
  token,
  request,
  paginate,
}) {
  let added = 0;
  const triage = new Set();
  if (graph.overflow) {
    return {
      added,
      triage: [...graph.errors.keys()].sort((left, right) => left - right),
    };
  }
  for (const [issueNumber, blockerNumbers] of graph.adjacency) {
    if (graph.errors.has(issueNumber)) continue;
    let nativeBlockers;
    try {
      nativeBlockers = await paginate(
        `/repos/${repository}/issues/${issueNumber}/dependencies/blocked_by`,
        { token, request },
      );
    } catch {
      graph.errors.set(issueNumber, "native-dependency-sync-failed");
      triage.add(issueNumber);
      continue;
    }
    const decision = nativeDependencyDecision(
      blockerNumbers,
      nativeBlockers,
      graph.issuesByNumber,
    );
    if (decision.status === "triage") {
      graph.errors.set(issueNumber, decision.reason);
      triage.add(issueNumber);
      continue;
    }
    for (const dependency of decision.add) {
      try {
        await request(
          `/repos/${repository}/issues/${issueNumber}/dependencies/blocked_by`,
          {
            token,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ issue_id: dependency.issueId }),
          },
        );
        added += 1;
      } catch {
        graph.errors.set(issueNumber, "native-dependency-sync-failed");
        triage.add(issueNumber);
        break;
      }
    }
  }
  return { added, triage: [...triage].sort((left, right) => left - right) };
}

async function sourceAuthorization({
  repository,
  source,
  token,
  request,
  paginate,
}) {
  const [comments, timeline] = await Promise.all([
    paginate(`/repos/${repository}/issues/${source.number}/comments`, {
      token,
      request,
    }),
    paginate(`/repos/${repository}/issues/${source.number}/events`, {
      token,
      request,
    }),
  ]);
  const contract = executionContent(source);
  const current = latestAuthorizationRecord(
    parseAuthorizationRecords(comments, source.number, timeline),
  );
  return { contract, current };
}

async function repairAuthorizationRecord({
  repository,
  source,
  contract,
  current,
  proposalEntries,
  token,
  request,
}) {
  if (
    !current ||
    !["active", "paused"].includes(current.state) ||
    current.executionContentHash !== contract.hash ||
    current.blockedByHash === contract.blockedByHash
  ) {
    return false;
  }
  const trustedNumbers = new Set(
    proposalEntries
      .filter(
        ({ record, issue }) =>
          record.sourceCycle === current.cycle &&
          record.executionContentHash === current.executionContentHash &&
          contract.blockerNumbers.includes(issue.number),
      )
      .map(({ issue }) => issue.number),
  );
  if (trustedNumbers.size === 0) return false;
  const matchingSplits = contract.blockerNumbers
    .map((_, split) => split)
    .filter((split) => {
      const suffix = contract.blockerNumbers.slice(split);
      return (
        suffix.every((number) => trustedNumbers.has(number)) &&
        blockedByStateHash(contract.blockerNumbers.slice(0, split)) ===
          current.blockedByHash
      );
    });
  if (matchingSplits.length !== 1) {
    return false;
  }
  const recordedAt = new Date().toISOString();
  const record = transitionAuthorization({
    current,
    state: current.state,
    transition: "frontier-updated",
    reason: "trusted-blocker-reconciler",
    actor: { login: "github-actions[bot]", type: "Bot" },
    eventId: `reconcile-${process.env.GITHUB_RUN_ID ?? "local"}-${contract.blockedByHash}`,
    eventAt: recordedAt,
    eventUrl:
      source.html_url ??
      `https://github.com/${repository}/issues/${source.number}`,
    recordedAt,
    blockedByHash: contract.blockedByHash,
  });
  await publishComment(
    repository,
    source.number,
    buildAuthorizationRecordComment(record),
    token,
    request,
  );
  return true;
}

async function trustedProposalGroups({
  repository,
  issues,
  token,
  request,
  paginate,
}) {
  const groups = new Map();
  const invalidIssues = [];
  const recoveryCandidates = [];
  for (const issue of issues) {
    if (issue.pull_request) continue;
    let rawRecord;
    try {
      rawRecord = parseBlockerProposalRecord(issue, { trusted: false });
    } catch {
      invalidIssues.push(issue.number);
      continue;
    }
    if (!rawRecord) continue;
    let record;
    let blockerComments;
    try {
      blockerComments = await paginate(
        `/repos/${repository}/issues/${issue.number}/comments`,
        { token, request },
      );
      record = parseBlockerProposalRecord(issue, { comments: blockerComments });
    } catch {
      invalidIssues.push(issue.number);
      continue;
    }
    if (!record) {
      if (
        isActionsCreatedBlockerIssue(issue) &&
        !hasTrustedBlockerIdentityAudit(blockerComments)
      ) {
        recoveryCandidates.push({
          issue: { ...issue, blockerComments },
          record: rawRecord,
        });
      } else {
        invalidIssues.push(issue.number);
      }
      continue;
    }
    const entries = groups.get(record.sourceIssue) ?? [];
    entries.push({ issue: { ...issue, blockerComments }, record });
    groups.set(record.sourceIssue, entries);
  }
  return { groups, invalidIssues, recoveryCandidates };
}

async function repairProposalState({
  repository,
  issues,
  token,
  request,
  paginate,
}) {
  const { groups, invalidIssues, recoveryCandidates } = await trustedProposalGroups({
    repository,
    issues,
    token,
    request,
    paginate,
  });
  const triage = new Set(invalidIssues);
  let changed = false;
  let repairedAuthorizations = 0;
  let repairedIdentities = 0;

  const trustedIdentityCounts = new Map();
  for (const entries of groups.values()) {
    for (const { record } of entries) {
      const identity = proposalIdentity(record);
      trustedIdentityCounts.set(identity, (trustedIdentityCounts.get(identity) ?? 0) + 1);
    }
  }
  const recoveryIdentityCounts = new Map();
  for (const { record } of recoveryCandidates) {
    const identity = proposalIdentity(record);
    recoveryIdentityCounts.set(identity, (recoveryIdentityCounts.get(identity) ?? 0) + 1);
  }
  const uniqueRecoveryCandidates = recoveryCandidates.filter(({ issue, record }) => {
    const identity = proposalIdentity(record);
    const count =
      (trustedIdentityCounts.get(identity) ?? 0) +
      (recoveryIdentityCounts.get(identity) ?? 0);
    if (count === 1) return true;
    triage.add(record.sourceIssue);
    triage.add(issue.number);
    return false;
  });

  for (const candidate of uniqueRecoveryCandidates) {
    const { issue, record } = candidate;
    const source = issues.find(
      (entry) => entry.number === record.sourceIssue && !entry.pull_request,
    );
    let authorization;
    try {
      authorization = source
        ? await sourceAuthorization({
            repository,
            source,
            token,
            request,
            paginate,
          })
        : null;
    } catch {
      authorization = null;
    }
    let unedited = false;
    try {
      unedited = await isUneditedActionsBlocker({
        repository,
        issue,
        token,
        request,
      });
    } catch {
      unedited = false;
    }
    if (
      !unedited ||
      !matchesRecoveryAuthorization(record, authorization)
    ) {
      triage.add(issue.number);
      if (source) triage.add(source.number);
      continue;
    }
    await publishComment(
      repository,
      issue.number,
      buildBlockerIdentityComment(record, issue),
      token,
      request,
    );
    const blockerComments = [
      ...issue.blockerComments,
      ...(await paginate(
        `/repos/${repository}/issues/${issue.number}/comments`,
        { token, request },
      )),
    ].filter(
      (comment, index, values) =>
        values.findIndex((candidate) => candidate.id === comment.id) === index,
    );
    const trusted = parseBlockerProposalRecord(issue, { comments: blockerComments });
    if (!trusted) {
      triage.add(issue.number);
      triage.add(source.number);
      continue;
    }
    const entries = groups.get(record.sourceIssue) ?? [];
    entries.push({ issue: { ...issue, blockerComments }, record: trusted });
    groups.set(record.sourceIssue, entries);
    repairedIdentities += 1;
    changed = true;
  }

  const sourceAuthorizations = new Map();
  for (const sourceIssue of groups.keys()) {
    const source = issues.find(
      (issue) => issue.number === sourceIssue && !issue.pull_request,
    );
    if (!source) continue;
    try {
      sourceAuthorizations.set(
        sourceIssue,
        await sourceAuthorization({
          repository,
          source,
          token,
          request,
          paginate,
        }),
      );
    } catch {
      // The group remains fail closed below.
    }
  }

  for (const [sourceIssue, entries] of groups) {
    const authorization = sourceAuthorizations.get(sourceIssue);
    for (const { issue, record } of entries) {
      if (isRetiredBlockerProposal(record, issue, authorization)) continue;
      await ensureReviewComment({
        repository,
        issueNumber: issue.number,
        record,
        token,
        request,
        paginate,
      });
    }
  }

  for (const [sourceIssue, entries] of groups) {
    const source = issues.find(
      (issue) => issue.number === sourceIssue && !issue.pull_request,
    );
    if (!source) {
      entries.forEach(({ issue }) => triage.add(issue.number));
      continue;
    }
    const authorization = sourceAuthorizations.get(sourceIssue);
    const activeEntries = authorization
      ? entries.filter(
          ({ issue, record }) =>
            !isRetiredBlockerProposal(record, issue, authorization),
        )
      : entries;
    const identities = activeEntries.map(({ record }) => proposalIdentity(record));
    if (new Set(identities).size !== identities.length) {
      triage.add(sourceIssue);
      activeEntries.forEach(({ issue }) => triage.add(issue.number));
      continue;
    }
    if (!authorization) {
      triage.add(sourceIssue);
      continue;
    }
    const { contract, current } = authorization;
    const currentBlockers = parseBlockedBy(source.body, {
      issueNumber: sourceIssue,
    });
    const missing = activeEntries.filter(
      ({ issue }) => !currentBlockers.includes(issue.number),
    );
    if (missing.length === 0) {
      if (
        await repairAuthorizationRecord({
          repository,
          source,
          contract,
          current,
          proposalEntries: activeEntries,
          token,
          request,
        })
      ) {
        repairedAuthorizations += 1;
      }
      continue;
    }
    const first = missing[0].record;
    if (
      missing.some(
        ({ record }) => !sameProposalSource(record, first),
      )
    ) {
      triage.add(sourceIssue);
      continue;
    }
    if (
      !current ||
      !["active", "paused"].includes(current.state) ||
      current.cycle !== first.sourceCycle ||
      current.executionContentHash !== first.executionContentHash ||
      current.executionContentHash !== contract.hash ||
      current.blockedByHash !== contract.blockedByHash
    ) {
      triage.add(sourceIssue);
      continue;
    }

    const graph = inspectBlockerGraph(issues);
    let nextBlockers;
    try {
      nextBlockers = assertCanAddBlockers(
        graph,
        sourceIssue,
        missing.map(({ issue }) => issue.number),
      );
    } catch {
      triage.add(sourceIssue);
      continue;
    }
    const nextBody = replaceBlockedBy(source.body, nextBlockers, {
      issueNumber: sourceIssue,
    });
    await request(`/repos/${repository}/issues/${sourceIssue}`, {
      token,
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: nextBody,
      }),
    });
    const nextSource = { ...source, body: nextBody };
    const nextContract = executionContent(nextSource);
    if (
      await repairAuthorizationRecord({
        repository,
        source: nextSource,
        contract: nextContract,
        current,
        proposalEntries: activeEntries,
        token,
        request,
      })
    ) {
      repairedAuthorizations += 1;
    }
    changed = true;
  }

  for (const issueNumber of triage) {
    const issue = issues.find((candidate) => candidate.number === issueNumber);
    if (issue?.state === "open" && !labelsOf(issue).includes("needs-triage")) {
      await addTriageLabel(repository, issueNumber, token, request);
    }
  }
  return {
    changed,
    repairedAuthorizations,
    repairedIdentities,
    recoveryPairs: [...groups.entries()].flatMap(([sourceIssue, entries]) => {
      const authorization = sourceAuthorizations.get(sourceIssue);
      return entries
        .filter(
          ({ issue, record }) =>
            issue.performed_via_github_app === null &&
            !isRetiredBlockerProposal(record, issue, authorization),
        )
        .map(({ issue, record }) => ({
          blockerIssue: issue.number,
          record,
          sourceIssue,
        }));
    }),
    triage: [...triage].sort((left, right) => left - right),
  };
}

export async function reconcileRepository({
  repository,
  token,
  request = githubRequest,
  paginate = githubPaginate,
  graphOptions,
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) {
    throw new Error("GitHub repository is invalid");
  }
  if (!token) throw new Error("GITHUB_TOKEN is required");
  let issues = await paginate(`/repos/${repository}/issues?state=all`, {
    token,
    request,
  });
  const repair = await repairProposalState({
    repository,
    issues,
    token,
    request,
    paginate,
  });
  if (repair.changed) {
    issues = await paginate(`/repos/${repository}/issues?state=all`, {
      token,
      request,
    });
  }

  const graph = inspectBlockerGraph(issues, graphOptions);
  const workerPullRequests = await paginate(
    `/repos/${repository}/pulls?state=all`,
    { token, request },
  );
  const nativeDependencies = await reconcileNativeDependencies({
    repository,
    graph,
    token,
    request,
    paginate,
  });
  let clearedTriage = 0;
  if (nativeDependencies.triage.length === 0 && graph.errors.size === 0) {
    for (const { blockerIssue, record, sourceIssue } of repair.recoveryPairs) {
      const source = issues.find((issue) => issue.number === sourceIssue);
      const blocker = issues.find((issue) => issue.number === blockerIssue);
      if (
        !source ||
        !blocker ||
        repair.triage.includes(sourceIssue) ||
        repair.triage.includes(blockerIssue)
      ) {
        continue;
      }
      let authorization;
      let unedited = false;
      try {
        [authorization, unedited] = await Promise.all([
          sourceAuthorization({
            repository,
            source,
            token,
            request,
            paginate,
          }),
          isUneditedActionsBlocker({
            repository,
            issue: blocker,
            token,
            request,
          }),
        ]);
      } catch {
        continue;
      }
      if (
        !unedited ||
        !matchesRecoveryAuthorization(record, authorization) ||
        !authorization.contract.blockerNumbers.includes(blockerIssue)
      ) {
        continue;
      }
      const [sourceComments, sourceEvents, blockerEvents] = await Promise.all([
        paginate(`/repos/${repository}/issues/${sourceIssue}/comments`, {
          token,
          request,
        }),
        paginate(`/repos/${repository}/issues/${sourceIssue}/events`, {
          token,
          request,
        }),
        paginate(`/repos/${repository}/issues/${blockerIssue}/events`, {
          token,
          request,
        }),
      ]);
      if (
        labelsOf(source).includes("needs-triage") &&
        hasSystemTriageEvidence({
          comments: sourceComments,
          events: sourceEvents,
          requirePublisherFailure: true,
        })
      ) {
        await removeTriageLabel(repository, sourceIssue, token, request);
        source.labels = (source.labels ?? []).filter(
          (label) => (typeof label === "string" ? label : label.name) !== "needs-triage",
        );
        clearedTriage += 1;
      }
      if (
        labelsOf(blocker).includes("needs-triage") &&
        hasSystemTriageEvidence({ events: blockerEvents })
      ) {
        await removeTriageLabel(repository, blockerIssue, token, request);
        blocker.labels = (blocker.labels ?? []).filter(
          (label) => (typeof label === "string" ? label : label.name) !== "needs-triage",
        );
        clearedTriage += 1;
      }
    }
  }
  const outcomes = [];
  for (const issueNumber of reconciliationIssueNumbers(graph)) {
    const issue = graph.issuesByNumber.get(issueNumber);
    if (!issue || issue.state !== "open") continue;
    const branchRefs = await paginate(
      `/repos/${repository}/git/matching-refs/heads/codex/issue-${issueNumber}-cycle-`,
      { token, request },
    );
    const state = bindWorkerTopology(
      classifyDependentBlockers(graph, issueNumber),
      repository,
      issueNumber,
      workerPullRequests,
      branchRefs,
    );
    const comments = await paginate(
      `/repos/${repository}/issues/${issueNumber}/comments`,
      { token, request },
    );
    const latestRecord = latestBlockerStateRecord(comments, issueNumber);
    const expectedOperation =
      state.state === "frontier"
        ? "evaluate"
        : state.state === "blocked"
          ? "pause"
          : "triage";
    const decision = dependentReconciliationDecision({
      issue,
      state,
      latestRecord,
      dispatchAcknowledged: hasTrustedWorkerDispatchAck(
        comments,
        issueNumber,
        state.signature,
        expectedOperation,
      ),
    });
    if (decision.addTriage) {
      await addTriageLabel(repository, issueNumber, token, request);
    }
    if (decision.comment) {
      await publishComment(
        repository,
        issueNumber,
        buildBlockerStateComment(state),
        token,
        request,
      );
    }
    if (decision.dispatch) {
      await dispatchWorker(
        repository,
        issueNumber,
        state,
        decision.dispatch.operation,
        token,
        request,
      );
    }
    outcomes.push({ issueNumber, state, decision });
  }
  return {
    outcomes,
    repairedAuthorizations: repair.repairedAuthorizations,
    repairedIdentities: repair.repairedIdentities,
    repairedEdges: repair.changed,
    repairedNativeDependencies: nativeDependencies.added,
    clearedTriage,
    nativeDependencyTriage: nativeDependencies.triage,
    triage: repair.triage,
  };
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  await reconcileRepository({
    repository: requiredEnvironment("GITHUB_REPOSITORY"),
    token: requiredEnvironment("GITHUB_TOKEN"),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
