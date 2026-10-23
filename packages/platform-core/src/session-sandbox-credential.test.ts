import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sessionSandboxFileExchangeTokenV1 } from "./session-sandbox-credential.js";

const deploymentToken = "synthetic-deployment-token-3276-0123456789";
const binding = {
	namespace: "agent-workloads",
	sandboxId: "sandbox-a",
	generation: 2,
	resourceFence: 3,
};

describe("sessionSandboxFileExchangeTokenV1 (#3276)", () => {
	it("derives one stable base64url HMAC per Sandbox allocation", () => {
		const token = sessionSandboxFileExchangeTokenV1(deploymentToken, binding);
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(sessionSandboxFileExchangeTokenV1(deploymentToken, binding)).toBe(
			token,
		);
		expect(token).not.toContain(deploymentToken);
	});

	it("binds the namespace, Sandbox, generation, resource fence and deployment token", () => {
		const token = sessionSandboxFileExchangeTokenV1(deploymentToken, binding);
		for (const changed of [
			{ ...binding, namespace: "other-namespace" },
			{ ...binding, sandboxId: "sandbox-b" },
			{ ...binding, generation: 3 },
			{ ...binding, resourceFence: 4 },
		])
			expect(
				sessionSandboxFileExchangeTokenV1(deploymentToken, changed),
			).not.toBe(token);
		expect(
			sessionSandboxFileExchangeTokenV1(`${deploymentToken}-rotated`, binding),
		).not.toBe(token);
	});

	it("uses a purpose distinct from the Sandbox transport token", () => {
		const transport = createHmac("sha256", deploymentToken)
			.update(`session-sandbox-v1\0${binding.namespace}\0${binding.sandboxId}`)
			.digest("base64url");
		expect(
			sessionSandboxFileExchangeTokenV1(deploymentToken, binding),
		).not.toBe(transport);
	});

	it.each([
		["an empty deployment token", "", binding],
		["an invalid namespace", deploymentToken, { ...binding, namespace: "A_B" }],
		["an empty Sandbox", deploymentToken, { ...binding, sandboxId: "" }],
		[
			"a Sandbox with a separator",
			deploymentToken,
			{ ...binding, sandboxId: "a\0b" },
		],
		["a zero generation", deploymentToken, { ...binding, generation: 0 }],
		["a fractional fence", deploymentToken, { ...binding, resourceFence: 1.5 }],
		["a zero fence", deploymentToken, { ...binding, resourceFence: 0 }],
	])("rejects %s", (_name, token, value) => {
		expect(() => sessionSandboxFileExchangeTokenV1(token, value)).toThrow(
			TypeError,
		);
	});
});
