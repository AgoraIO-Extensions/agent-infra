import { FileLimitsV1Schema } from "@agent-infra/contracts/files";

/**
 * Read-only file limits fixture for the conversation file picker. The picker
 * reads the current limits per conversation before it enables an upload.
 */
export const controlledFileLimits = () =>
	FileLimitsV1Schema.parse({
		schemaVersion: 1,
		revision: "controlled-files-v1",
		expiresAt: "2027-01-01T00:00:00Z",
		mediaTypes: ["text/plain", "application/pdf"],
		maxBytes: 10 * 1024 * 1024,
	});

export const isFileLimitsRequest = (method: string, pathname: string) =>
	method === "GET" && pathname.endsWith("/files/limits");
