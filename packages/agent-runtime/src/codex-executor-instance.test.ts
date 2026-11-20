import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
	issueExecutorStartIdentityV1,
	verifyExecutorStartIdentityV1,
} from "./codex-executor-bootstrap.js";
import {
	signExecutorControlV1,
	verifyExecutorControlV1,
} from "./codex-executor-control.js";
import {
	codexSessionExecutorBindingDigestV1,
	createCodexSessionExecutorBindingV1,
	pinCodexSessionExecutorEpochV1,
} from "./codex-session-executor.js";

it("pins separately authorized Pods under the same binding without replacing the original epoch or facts", async () => {
	const directory = await mkdtemp(join(tmpdir(), "executor-instance-pin-"));
	const issuer = generateKeyPairSync("ed25519");
	const binding = createCodexSessionExecutorBindingV1({
		namespace: "fixture",
		podName: "sandbox-fixture",
		sandboxId: "fixture",
		agentId: "agent",
		conversationId: "conversation",
		sessionGeneration: 2,
		resourceFence: 3,
		imageDigest: `registry.example/runtime@sha256:${"a".repeat(64)}`,
	});
	let runner: ReturnType<typeof verifyExecutorStartIdentityV1>;
	const transport = vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async (url, options) => {
			const path = new URL(String(url)).pathname;
			const request = verifyExecutorControlV1(
				runner,
				path,
				JSON.parse(String(options?.body)),
			);
			if (!request) throw new Error("invalid fixture authentication");
			return Response.json(
				signExecutorControlV1(
					runner,
					`${path}/result`,
					{ epoch: activeEpoch },
					request.requestId,
					request.deadline,
				),
			);
		});
	let activeEpoch = randomUUID();
	try {
		const snapshots: Map<string, string>[] = [];
		for (const podUid of ["pod-one", "pod-two"]) {
			const start = {
				podUid,
				bindingDigest: codexSessionExecutorBindingDigestV1(binding),
				startupRef: `executor-${randomUUID()}`,
				expiresAt: Date.now() + 60000,
				schemaVersion: 2 as const,
				purpose: "executor-instance-startup-v2" as const,
				instance: {
					attemptId: randomUUID(),
					recordRef: randomUUID(),
					sandboxId: binding.sandboxId,
					configurationRevision: 7,
					configurationVersion: "configuration-seven",
					generation: 2,
					resourceFence: 3,
				},
			};
			const material = issueExecutorStartIdentityV1(start, issuer.privateKey);
			const expected = {
				...start,
				issuerKey: issuer.publicKey,
				now: Date.now(),
			};
			const host = verifyExecutorStartIdentityV1(material.host, {
				...expected,
				role: "host",
			});
			runner = verifyExecutorStartIdentityV1(material.runner, {
				...expected,
				role: "runner",
			});
			activeEpoch = randomUUID();
			const admission = {
				binding,
				podUid,
				epoch: activeEpoch,
				assertCurrent: async () => {},
				onFailure: () => () => {},
				close: async () => {},
			};
			await pinCodexSessionExecutorEpochV1(
				directory,
				admission,
				host,
				"configuration-seven",
			);
			await pinCodexSessionExecutorEpochV1(
				directory,
				admission,
				host,
				"configuration-seven",
			);
			const entries = new Map<string, string>();
			for (const file of await readdir(directory))
				entries.set(file, await readFile(join(directory, file), "utf8"));
			snapshots.push(entries);
			await expect(
				pinCodexSessionExecutorEpochV1(
					directory,
					{ ...admission, epoch: randomUUID() },
					host,
					"configuration-seven",
				),
			).rejects.toThrow("CODEX_SESSION_EXECUTOR_INVALID");
		}
		expect(snapshots[0]?.size).toBe(1);
		expect(snapshots[1]?.size).toBe(2);
		for (const [name, bytes] of snapshots[0] ?? [])
			expect(snapshots[1]?.get(name)).toBe(bytes);
	} finally {
		transport.mockRestore();
		await rm(directory, { recursive: true, force: true });
	}
});

it("does not turn a legacy pin or caller-shaped identity into authority for a V2 instance", async () => {
	const directory = await mkdtemp(join(tmpdir(), "executor-old-pin-"));
	const binding = createCodexSessionExecutorBindingV1({
		namespace: "fixture",
		podName: "sandbox-fixture",
		sandboxId: "fixture",
		agentId: "agent",
		conversationId: "conversation",
		sessionGeneration: 2,
		resourceFence: 3,
		imageDigest: `registry.example/runtime@sha256:${"a".repeat(64)}`,
	});
	const issuer = generateKeyPairSync("ed25519");
	const start = {
		schemaVersion: 2 as const,
		purpose: "executor-instance-startup-v2" as const,
		podUid: "new-pod",
		bindingDigest: codexSessionExecutorBindingDigestV1(binding),
		startupRef: "executor-new",
		expiresAt: Date.now() + 60000,
		instance: {
			attemptId: randomUUID(),
			recordRef: randomUUID(),
			sandboxId: binding.sandboxId,
			configurationRevision: 1,
			configurationVersion: "configuration-one",
			generation: 2,
			resourceFence: 3,
		},
	};
	const material = issueExecutorStartIdentityV1(start, issuer.privateKey);
	const identity = verifyExecutorStartIdentityV1(material.host, {
		...start,
		role: "host",
		now: Date.now(),
		issuerKey: issuer.publicKey,
	});
	const admission = {
		binding,
		podUid: start.podUid,
		epoch: randomUUID(),
		assertCurrent: async () => {},
		onFailure: () => () => {},
		close: async () => {},
	};
	try {
		await expect(
			pinCodexSessionExecutorEpochV1(
				directory,
				admission,
				{ ...identity },
				"configuration-one",
			),
		).rejects.toThrow("CODEX_SESSION_EXECUTOR_INVALID");
		const path = join(directory, `.executor-${start.bindingDigest}.json`);
		const bytes = JSON.stringify({ schemaVersion: 1, epoch: randomUUID() });
		await writeFile(path, bytes, { mode: 0o600 });
		await expect(
			pinCodexSessionExecutorEpochV1(
				directory,
				admission,
				identity,
				"configuration-one",
			),
		).rejects.toThrow("CODEX_SESSION_EXECUTOR_INVALID");
		expect(await readFile(path, "utf8")).toBe(bytes);
		expect((await readdir(directory)).length).toBe(1);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
