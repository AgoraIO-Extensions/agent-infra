import { FileLimitsV1Schema } from "@agent-infra/contracts/files";

/**
 * Read-only file limits fixture for the conversation file picker. The picker
 * reads the current limits per conversation before it enables an upload.
 */
export const controlledFileLimits = () => ({
	schemaVersion: 1,
	declaration: {
		schemaVersion: 1,
		scope: "agent" as const,
		revision: 1,
		expiresAt: "2027-01-01T00:00:00Z",
		mediaTypes: ["text/plain", "application/pdf"],
		maxBytes: 10 * 1024 * 1024,
		updatedAt: "2026-01-01T00:00:00Z",
		updatedBy: "controlled-employee",
	},
});

export const isFileLimitsRequest = (method: string, pathname: string) =>
	method === "GET" && pathname.endsWith("/file-limits");
