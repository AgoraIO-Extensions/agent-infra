import { createHash } from "node:crypto";

/** Stable deployed resource identity shared by the Runtime and config producer. */
export function workloadResourceNameV1(agentId: string): string {
	return (
		"agent-" + createHash("sha256").update(agentId).digest("hex").slice(0, 32)
	);
}
