import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
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

it.each([
	"matching",
	"missing",
	"wrong-epoch",
	"wrong-binding",
	"wrong-pod",
	"wrong-role",
	"v2-pin",
	"symlink",
	"unverified",
])(
	"only reads the existing original pin for a verified V1 identity: %s",
	async (scenario) => {
		const directory = await mkdtemp(join(tmpdir(), "executor-v1-upgrade-"));
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
		const admission = {
			binding,
			podUid: "original-pod",
			epoch: randomUUID(),
			assertCurrent: async () => {},
			onFailure: () => () => {},
			close: async () => {},
		};
		const issuer = generateKeyPairSync("ed25519");
		const start = {
			podUid: scenario === "wrong-pod" ? "other-pod" : admission.podUid,
			bindingDigest:
				scenario === "wrong-binding"
					? "b".repeat(64)
					: codexSessionExecutorBindingDigestV1(binding),
			startupRef: "original-start",
			expiresAt: Date.now() + 60_000,
		};
		const material = issueExecutorStartIdentityV1(start, issuer.privateKey);
		const expected = { ...start, now: Date.now(), issuerKey: issuer.publicKey };
		const host = verifyExecutorStartIdentityV1(material.host, {
			...expected,
			role: "host",
		});
		let runner = verifyExecutorStartIdentityV1(material.runner, {
			...expected,
			role: "runner",
		});
		const path = join(
			directory,
			`.executor-${codexSessionExecutorBindingDigestV1(binding)}.json`,
		);
		const transport = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (url, options) => {
				const route = new URL(String(url)).pathname;
				const request = verifyExecutorControlV1(
					runner,
					route,
					JSON.parse(String(options?.body)),
				);
				if (!request) throw new Error("invalid fixture authentication");
				return Response.json(
					signExecutorControlV1(
						runner,
						`${route}/result`,
						{ epoch: admission.epoch },
						request.requestId,
						request.deadline,
					),
				);
			});
		try {
			if (scenario !== "missing" && scenario !== "v2-pin")
				await pinCodexSessionExecutorEpochV1(directory, admission);
			if (scenario === "v2-pin") {
				const v2 = {
					...start,
					schemaVersion: 2 as const,
					purpose: "executor-instance-startup-v2" as const,
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
				const signed = issueExecutorStartIdentityV1(v2, issuer.privateKey);
				const v2Expected = {
					...v2,
					issuerKey: issuer.publicKey,
					now: Date.now(),
				};
				const originalRunner = runner;
				runner = verifyExecutorStartIdentityV1(signed.runner, {
					...v2Expected,
					role: "runner",
				});
				await pinCodexSessionExecutorEpochV1(
					directory,
					admission,
					verifyExecutorStartIdentityV1(signed.host, {
						...v2Expected,
						role: "host",
					}),
					"configuration-one",
				);
				runner = originalRunner;
			}
			if (scenario === "symlink") {
				await writeFile(
					join(directory, "original.json"),
					await readFile(path),
					{ mode: 0o600 },
				);
				await unlink(path);
				await symlink(join(directory, "original.json"), path);
			}
			const files = new Map(
				await Promise.all(
					(await readdir(directory)).map(
						async (name) =>
							[name, await readFile(join(directory, name), "utf8")] as const,
					),
				),
			);
			if (scenario === "wrong-epoch") admission.epoch = randomUUID();
			const operation = () =>
				pinCodexSessionExecutorEpochV1(
					directory,
					admission,
					scenario === "unverified"
						? { ...host }
						: scenario === "wrong-role"
							? runner
							: host,
				);
			if (scenario === "matching")
				await expect(operation()).resolves.toBeUndefined();
			else
				await expect(operation()).rejects.toThrow(
					"CODEX_SESSION_EXECUTOR_INVALID",
				);
			expect(
				new Map(
					await Promise.all(
						(await readdir(directory)).map(
							async (name) =>
								[name, await readFile(join(directory, name), "utf8")] as const,
						),
					),
				),
			).toEqual(files);
		} finally {
			transport.mockRestore();
			await rm(directory, { recursive: true, force: true });
		}
	},
);
