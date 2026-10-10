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
