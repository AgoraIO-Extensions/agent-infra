import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	issueExecutorStartIdentityV1,
	verifyExecutorStartIdentityV1,
} from "./codex-executor-bootstrap.js";

const worker = generateKeyPairSync("ed25519");
const start = {
	podUid: "pod-original",
	bindingDigest: "a".repeat(64),
	startupRef: "bootstrap-original",
	expiresAt: 10_000,
};

describe("executor startup identity", () => {
	it("pins two independent identities for the original Pod", () => {
		const materials = issueExecutorStartIdentityV1(start, worker.privateKey);
		const host = verifyExecutorStartIdentityV1(materials.host, {
			...start,
			role: "host",
			now: 9_999,
			issuerKey: worker.publicKey,
		});
		const runner = verifyExecutorStartIdentityV1(materials.runner, {
			...start,
			role: "runner",
			now: 9_999,
			issuerKey: worker.publicKey,
		});
		expect(host.publicKey).not.toBe(runner.publicKey);
		expect(host.peerKey).toBe(runner.publicKey);
		expect(runner.peerKey).toBe(host.publicKey);
	});

	it.each([
		{ podUid: "replacement-pod" },
		{ bindingDigest: "b".repeat(64) },
		{ role: "runner" as const },
		{ startupRef: "other-startup" },
		{ expiresAt: 9_999 },
		{ now: 10_000 },
		{ issuerKey: generateKeyPairSync("ed25519").publicKey },
	])("rejects mismatched trusted startup input %#", (override) => {
		const { host } = issueExecutorStartIdentityV1(start, worker.privateKey);
		expect(() =>
			verifyExecutorStartIdentityV1(host, {
				...start,
				role: "host",
				now: 9_999,
				issuerKey: worker.publicKey,
				...override,
			}),
		).toThrow("CODEX_EXECUTOR_START_IDENTITY_INVALID");
	});

	it("rejects a private key swapped with a different role or startup", () => {
		const { host, runner } = issueExecutorStartIdentityV1(
			start,
			worker.privateKey,
		);
		expect(() =>
			verifyExecutorStartIdentityV1(
				{ ...host, privateKey: runner.privateKey },
				{
					...start,
					role: "host",
					now: 9_999,
					issuerKey: worker.publicKey,
				},
			),
		).toThrow("CODEX_EXECUTOR_START_IDENTITY_INVALID");
	});
});
