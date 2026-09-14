import { generateKeyPairSync, sign } from "node:crypto";
import {
	ExecutionGrantV1Schema,
	type WorkloadReadinessGrantClaimsV1,
	type WorkloadReadinessRequestV1,
} from "@agent-infra/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createExecutionGrantVerifier } from "./grant.js";
import { createWorkloadReadinessVerifierV1 } from "./readiness.js";

const keys = generateKeyPairSync("ed25519");
const now = Date.now();
const binding = {
	workerId: "worker-a",
	agentId: "agent-a",
	workloadRevision: 2,
	fence: 4,
	imageDigest: `sha256:${"a".repeat(64)}`,
};
const request = {
	schemaVersion: 1 as const,
	...binding,
	requestId: "request-a",
	traceId: "trace-a",
};
const claims: WorkloadReadinessGrantClaimsV1 = {
	...request,
	issuer: "platform",
	audience: "runtime_host_readiness",
	purpose: "readiness.read",
	grantId: "grant-a",
	issuedAt: now,
	expiresAt: now + 30_000,
};
function signed(
	value: unknown = claims,
	header: unknown = {
		alg: "EdDSA",
		kid: "key-a",
		typ: "workload-readiness+jws",
	},
): WorkloadReadinessRequestV1 {
	const prefix = [header, value]
		.map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
		.join(".");
	return {
		...request,
		grant: {
			schemaVersion: 1,
			format: "workload-readiness-jws",
			token: `${prefix}.${sign(null, Buffer.from(prefix), keys.privateKey).toString("base64url")}`,
		},
	};
}
const verify = createWorkloadReadinessVerifierV1({
	binding,
	publicKeys: new Map([["key-a", keys.publicKey]]),
	expectedIssuer: "platform",
	now: () => now,
});

describe("Workload readiness proof isolation", () => {
	it("verifies actual Ed25519 signature and exact injected target plus authenticated Worker", () => {
		expect(verify(signed(), "worker-a")).toEqual(claims);
		expect(() => verify(signed(), "worker-b")).toThrow(
			"Workload readiness authorization is invalid",
		);
	});
	it.each([
		["purpose", "turn.submit"],
		["audience", "runtime_host"],
		["issuer", "foreign"],
		["workerId", "worker-b"],
		["agentId", "agent-b"],
		["workloadRevision", 3],
		["fence", 5],
		["imageDigest", `sha256:${"b".repeat(64)}`],
		["requestId", "request-b"],
		["traceId", "trace-b"],
		["expiresAt", now],
		["expiresAt", now + 30_001],
		["issuedAt", now + 1],
		["conversationId", "fabricated"],
		["actionSetVersion", "fabricated"],
	])("rejects signed %s mismatch", (field, value) => {
		expect(() =>
			verify(signed({ ...claims, [field]: value }), "worker-a"),
		).toThrow("Workload readiness authorization is invalid");
	});
	it("rejects request substitution, a modified signature and wrong protected headers", () => {
		for (const field of ["agentId", "workerId", "requestId", "traceId"])
			expect(() =>
				verify({ ...signed(), [field]: "foreign" }, "worker-a"),
			).toThrow();
		const tampered = signed();
		const parts = tampered.grant.token.split(".");
		parts[2] = Buffer.alloc(64).toString("base64url");
		expect(() =>
			verify(
				{ ...tampered, grant: { ...tampered.grant, token: parts.join(".") } },
				"worker-a",
			),
		).toThrow();
		for (const header of [
			{ alg: "none", kid: "key-a", typ: "workload-readiness+jws" },
			{ alg: "EdDSA", kid: "foreign", typ: "workload-readiness+jws" },
			{ alg: "EdDSA", kid: "key-a" },
		])
			expect(() => verify(signed(claims, header), "worker-a")).toThrow();
	});
	it("cannot be parsed or verified as a business Execution Grant", () => {
		const proof = signed().grant;
		expect(ExecutionGrantV1Schema.safeParse(proof).success).toBe(false);
		const businessVerify = createExecutionGrantVerifier(
			new Map([["key-a", keys.publicKey]]),
		);
		expect(() => businessVerify({ ...proof, format: "compact-jws" })).toThrow();
	});
});
