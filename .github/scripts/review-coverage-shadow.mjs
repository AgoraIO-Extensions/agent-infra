import { appendFile } from "node:fs/promises";
import { buildGitInventory, verifyShadowMetadata } from "../../packages/review-coverage/dist/index.mjs";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`review-output-missing: ${name}`);
  return value;
};
const integer = (name) => {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`review-output-invalid: ${name}`);
  return value;
};
const jsonRequired = (name) => {
  try { return JSON.parse(required(name)); }
  catch { throw new Error(`review-output-invalid: ${name}`); }
};

try {
  const workspace = required("GITHUB_WORKSPACE");
  const baseSha = required("REVIEW_COVERAGE_BASE_SHA");
  const headSha = required("REVIEW_COVERAGE_HEAD_SHA");
  const mergeBaseSha = required("REVIEW_COVERAGE_MERGE_BASE_SHA");
  const metadataText = required("REVIEW_COVERAGE_METADATA");
  const inventory = await buildGitInventory(workspace, baseSha, headSha);
  if (inventory.mergeBaseSha !== mergeBaseSha) throw new Error("review-output-invalid: merge-base mismatch");
  const runtimeKind = required("REVIEW_COVERAGE_RUNTIME_KIND");
  const derivedIdentity = runtimeKind === "derived" ? {
    sourceCommit: required("REVIEW_COVERAGE_SOURCE_COMMIT"),
    patchSha256: required("REVIEW_COVERAGE_PATCH_SHA256"),
    buildProvenance: jsonRequired("REVIEW_COVERAGE_BUILD_PROVENANCE"),
  } : {};
  const metadata = verifyShadowMetadata(metadataText, {
    repositoryId: integer("REVIEW_COVERAGE_REPOSITORY_ID"),
    repositoryName: required("GITHUB_REPOSITORY"),
    pullRequest: integer("REVIEW_COVERAGE_PULL_REQUEST"),
    baseSha,
    headSha,
    mergeBaseSha,
    workflowRunId: integer("GITHUB_RUN_ID"),
    runAttempt: integer("GITHUB_RUN_ATTEMPT"),
    analysisJobId: required("REVIEW_COVERAGE_ANALYSIS_JOB_ID"),
    provider: required("REVIEW_COVERAGE_PROVIDER"),
    reviewer: required("REVIEW_COVERAGE_REVIEWER"),
    runtimeKind,
    recorderVersion: required("REVIEW_COVERAGE_RECORDER_VERSION"),
    templateVersion: required("REVIEW_COVERAGE_TEMPLATE_VERSION"),
    transportVersion: required("REVIEW_COVERAGE_TRANSPORT_VERSION"),
    tokenCap: integer("REVIEW_COVERAGE_TOKEN_CAP"),
    diffSha256: required("REVIEW_COVERAGE_DIFF_SHA256"),
    diffBytes: integer("REVIEW_COVERAGE_DIFF_BYTES"),
    imageDigest: required("REVIEW_COVERAGE_IMAGE_DIGEST"),
    ...derivedIdentity,
    mergedOutputSha256: required("REVIEW_COVERAGE_MERGED_OUTPUT_SHA256"),
    successfulResponseSha256: jsonRequired("REVIEW_COVERAGE_RESPONSE_DIGESTS"),
  }, inventory);
  const summary = [
    "### PR-Agent trusted chunk shadow",
    "",
    "- result: `complete`",
    `- provider: \`${metadata.provider}\``,
    `- head_sha: \`${metadata.headSha}\``,
    `- chunks: ${metadata.chunks.length}`,
    `- inventory_sha256: \`${metadata.inventory.digest}\``,
    "",
  ].join("\n");
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary, "utf8");
} catch (error) {
  const message = error instanceof Error ? error.message : "review-output-invalid: shadow verifier failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
