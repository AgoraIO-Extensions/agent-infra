import { describe, expect, it } from "vitest";
import {
	contractSha256,
	directMcpContract,
	evaluateConnectionReadiness,
} from "./readiness.js";

describe("Connection readiness evidence", () => {
	it("requires every exact-head/runtime/readback field", () => {
		const result = evaluateConnectionReadiness({
			repository: "AgoraIO-Extensions/agent-infra",
		});
		expect(result.status).toBe("No-Go");
		expect(result.missing).toContain("exact source commit");
		expect(result.missing).toContain("image digest");
	});

	it("is deterministic for the versioned Direct MCP contract", () => {
		expect(contractSha256()).toMatch(/^[a-f0-9]{64}$/);
		expect(contractSha256()).toBe(contractSha256(directMcpContract));
	});
});
