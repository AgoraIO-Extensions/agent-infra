import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	type ConnectionHostSupplyBindingV1,
	encodeConnectionHostSupplyAadV1,
	openConnectionHostSupplyV1,
	sealConnectionHostSupplyV1,
} from "./host-supply-crypto.js";

const binding: ConnectionHostSupplyBindingV1 = {
	deploymentIdentity: "namespace/release",
	hostRef: "host-1",
	sandboxId: "sandbox-1",
	podUid: "pod-1",
	sessionGeneration: 7,
	resourceFence: 23,
	supplyRef: "supply-1",
	supplyRevision: "r4",
	attemptId: "attempt-1",
	templateDigest: "f".repeat(64),
};
const canary = Buffer.from("synthetic-connection-supply-test-canary");

describe("Connection Host private supply encryption", () => {
	it("uses the shared domain and fixed wire encoding", () => {
		const encoded = encodeConnectionHostSupplyAadV1(binding);
		const chunks: string[] = [];
		let offset = 0;
		while (offset < encoded.byteLength) {
			const length = encoded.readUInt32BE(offset);
			offset += 4;
			chunks.push(encoded.subarray(offset, offset + length).toString("utf8"));
			offset += length;
		}
		expect(chunks).toEqual([
			"agent-infra/connection-host-supply/v1",
			"namespace/release",
			"host-1",
			"sandbox-1",
			"pod-1",
			"7",
			"23",
			"supply-1",
			"r4",
			"attempt-1",
			"f".repeat(64),
		]);
		expect(offset).toBe(encoded.byteLength);
		expect(() =>
			encodeConnectionHostSupplyAadV1({ ...binding, attemptId: undefined }),
		).toThrow("CONNECTION_HOST_SUPPLY_UNAVAILABLE");
		expect(() =>
			encodeConnectionHostSupplyAadV1({ ...binding, extra: "ref" }),
		).toThrow("CONNECTION_HOST_SUPPLY_UNAVAILABLE");
	});

	it("authenticates the intended delivery and selects a fresh nonce", () => {
		const key = randomBytes(32);
		const original = sealConnectionHostSupplyV1(canary, key, binding);
		const next = sealConnectionHostSupplyV1(canary, key, binding);
		expect(next.nonce).not.toBe(original.nonce);
		expect(JSON.stringify(original)).not.toContain(canary.toString());
		const opened = openConnectionHostSupplyV1(original, key, binding);
		try {
			expect(opened.equals(canary)).toBe(true);
		} finally {
			opened.fill(0);
		}
	});

	it.each([
		["other release", { deploymentIdentity: "namespace/other-release" }],
		["other Host", { hostRef: "host-2" }],
		["other Sandbox", { sandboxId: "sandbox-2" }],
		["old Pod", { podUid: "pod-old" }],
		["old generation", { sessionGeneration: 6 }],
		["stale fence", { resourceFence: 22 }],
		["other supply", { supplyRef: "supply-2" }],
		["old revision", { supplyRevision: "r3" }],
		["old attempt", { attemptId: "attempt-old" }],
		["other registration template", { templateDigest: "a".repeat(64) }],
	])("rejects ciphertext for %s under the current context", (_, stale) => {
		const key = randomBytes(32);
		const envelope = sealConnectionHostSupplyV1(canary, key, {
			...binding,
			...stale,
		});
		expect(() => openConnectionHostSupplyV1(envelope, key, binding)).toThrow(
			"CONNECTION_HOST_SUPPLY_UNAVAILABLE",
		);
	});

	it("rejects a modified tag before returning plaintext", () => {
		const key = randomBytes(32);
		const envelope = sealConnectionHostSupplyV1(canary, key, binding);
		const tag = Buffer.from(envelope.tag, "base64url");
		tag[0] = (tag[0] ?? 0) ^ 1;
		expect(() =>
			openConnectionHostSupplyV1(
				{ ...envelope, tag: tag.toString("base64url") },
				key,
				binding,
			),
		).toThrow("CONNECTION_HOST_SUPPLY_UNAVAILABLE");
	});
});
