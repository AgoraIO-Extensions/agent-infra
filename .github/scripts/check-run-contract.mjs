export const GITHUB_ACTIONS_APP_ID = 15_368;

export function gateExternalId({ name, headSha, prNumber }) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `agent-infra:pr:${prNumber}:${slug}:${headSha}`;
}

export function selectCurrentGateCheck(checkRuns, { name, headSha, prNumber }) {
  const externalId = gateExternalId({ name, headSha, prNumber });
  return [...checkRuns]
    .filter(
      (check) =>
        check.name === name &&
        check.head_sha === headSha &&
        check.app?.id === GITHUB_ACTIONS_APP_ID &&
        check.external_id === externalId,
    )
    .sort((left, right) => right.id - left.id)[0];
}
