// Copy this file outside the repository as configuration.mjs and replace the
// placeholders with reviewed deployment code. This module is mounted only in
// the Worker Pod; never put its private files into an image or API Secret.

import { requiredFile } from "./environment.mjs";

const missing = (name) => {
	throw new Error(`Configure Worker export: ${name}`);
};

export const directory = missing("directory");
export const signing = missing("signing");
export const serviceToken = await requiredFile("PLATFORM_WORKER_SERVICE_TOKEN_FILE");
// databaseUrl comes from PLATFORM_DATABASE_URL, never from this module.
// policy.namespace must match the Pod namespace in PLATFORM_WORKER_NAMESPACE.
export const workloadInput = missing("workloadInput");

// Optional ACP model-directory internal gateway. Provide the already-bound
// RuntimeHost resolver and Worker Grant signer from the deployment module;
// callers never choose a Runtime URL, Session, or Grant.
export const modelDirectory = undefined;

// Optional saved Agent default Relay Key candidate seam. The reader is
// deployment-owned and must decrypt only inside Worker, returning endpoint,
// model and reasoning metadata through the authenticated internal gateway.
export const savedKeyCandidates = undefined;

// Optional production reader policy. When supplied, Worker assembles the
// Store-backed Owner/version check, Worker-only decryptor, and model visibility
// validator. `catalogRevision` must match the deployment model snapshot.
export const savedKeyCandidatesPolicy = undefined;

// Optional Store-backed Skill materialization. Its agentVersion must be the
// same value as the API's apiInput.agentVersion; read the shared environment:
//   agentVersion: process.env.AGENT_INFRA_AGENT_VERSION,
// Leaving this undefined keeps Skill materialization unavailable.
export const skillMaterialization = undefined;

// Optional native metadata gateway. The deployment must provide only the
// persisted Execution→Host binding resolver and a fixed Runtime target
// resolver; proof signing defaults to the Worker `signing` key above. When
// Platform API current confirmation is enabled, set `platformApiCurrent` to a
// fixed `{ baseUrl, serviceToken }` client target. Missing or stale ports stay
// unavailable and never fall back to direct Runtime access.
export const nativeMetadataGateway = undefined;

// workloadInput.files is optional during deployments without file support. If
// enabled, provide the same deployment-owned S3-compatible adapter used by the
// API and bounded batch/orphan settings for reconciliation.

// Use runtimeImageBinding() from environment.mjs when constructing
// templateModelBindings. The binding is a reviewed repository+Digest pair
// supplied by the Harness; the model catalog and admission policy remain
// deployment-owned code.
//
// Worker -> Runtime uses in-cluster plaintext HTTP (ADR-0020); no Runtime TLS
// policy is configured. Private inputs listed in E2E_WORKER_DEPLOYMENT_FILES
// are mounted read-only under /var/run/agent-infra/deployment/.
