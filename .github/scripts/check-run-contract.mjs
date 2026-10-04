export const GITHUB_ACTIONS_APP_ID = 15_368;
export const GATE_PUBLISHER_APP_ID = 4_503_079;

export function gateExternalId({ name, headSha, prNumber }) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `agent-infra:pr:${prNumber}:${slug}:${headSha}`;
}
