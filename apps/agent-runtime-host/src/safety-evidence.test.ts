import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	RuntimeHost,
	RuntimeSafetyEvidenceLogV1,
} from "@agent-infra/agent-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeHostApp } from "./app.js";
import {
	openRuntimeSafetyEvidenceV1,
	readRuntimeSafetyEvidenceWindowV1,
	runtimeSafetyEvidenceWindowEnvironmentV1,
} from "./safety-evidence.js";

const token = "synthetic-service-proof";
const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});
async function directory() {
	const created = await mkdtemp(join(tmpdir(), "host-safety-evidence-"));
	directories.push(created);
	return created;
}

const window = {
	schemaVersion: 1,
	windowRef: "window-1",
	opensAt: "2026-11-22T00:00:00.000Z",
	closesAt: "2026-11-22T02:00:00.000Z",
	agentIds: ["agent-1"],
	principalRefs: ["p1-principal"],
	scenarios: [
		{
			id: "u1-file",
			version: 1,
			resourceClasses: ["file"],
			actionClasses: ["read"],
		},
	],
	producers: [{ kind: "native_helper", version: "u1-helper-1" }],
};

const record = {
	schemaVersion: 1,
	code: "RUNTIME_ISOLATION_EVIDENCE_V1",
	kind: "isolation_observation",
	binding: {
		evidenceId: "evidence-1",
		scenario: { id: "u1-file", version: 1 },
		windowRef: "window-1",
		challengeRef: "challenge-1",
		agentId: "agent-1",
		conversationId: "conversation-1",
		executionId: "execution-1",
		operation: { ref: "operation-1", attemptRef: "attempt-1" },
		principalRef: "p1-principal",
		purposeRef: "business",
		sessionGeneration: 1,
		executionDeliveryFence: 1,
		sandbox: {
			ref: "sandbox-1",
			podUid: "11111111-2222-4333-8444-555555555555",
			resourceFence: 1,
		},
		host: {
			instanceRef: "host-1",
			startRef: "start-1",
			configurationRevision: "7",
			imageDigest: `sha256:${"a".repeat(64)}`,
		},
		producer: { kind: "native_helper", version: "u1-helper-1" },
		observedAt: "2026-11-22T00:30:00.000Z",
		clockId: "clock-1",
		sequence: 1,
	},
	resourceClass: "file",
	actionClass: "read",
	targetScope: "foreign",
	resultClass: "denied",
	nativeObserved: true,
	failureClass: "permission_denied",
};

function app(safetyEvidence?: RuntimeSafetyEvidenceLogV1) {
	return createRuntimeHostApp({
		host: {} as RuntimeHost,
		serviceToken: token,
		verifyGrant: () => {
			throw new Error("not used");
		},
		...(safetyEvidence ? { safetyEvidence } : {}),
	});
}

function post(
	target: ReturnType<typeof app>,
	path: string,
	body: unknown,
	authorization: string | null = `Bearer ${token}`,
) {
	return target.request(path, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(authorization ? { authorization } : {}),
		},
		body: JSON.stringify(body),
	});
}

const readBody = {
	schemaVersion: 1,
	capability: "runtime-safety-evidence-v1",
	after: null,
	limit: 10,
};

describe("deployment window (Spec §18.5.1 验收场景, default off)", () => {
	it("is off without configuration and refuses invalid documents", () => {
		expect(readRuntimeSafetyEvidenceWindowV1({})).toEqual({
			status: "disabled",
		});
		for (const value of [
			"{",
			JSON.stringify({ ...window, closesAt: window.opensAt }),
			JSON.stringify({
				...window,
				closesAt: "2026-11-26T00:00:00.000Z",
			}),
			JSON.stringify({ ...window, agentIds: ["agent-1", "agent-1"] }),
			JSON.stringify({ ...window, extra: true }),
			"x".repeat(40_000),
		])
			expect(
				readRuntimeSafetyEvidenceWindowV1({
					[runtimeSafetyEvidenceWindowEnvironmentV1]: value,
				}),
			).toEqual({ status: "invalid" });
		expect(
			readRuntimeSafetyEvidenceWindowV1({
				[runtimeSafetyEvidenceWindowEnvironmentV1]: JSON.stringify(window),
			}),
		).toMatchObject({ status: "enabled", window: { windowRef: "window-1" } });
	});

	it("produces no file and no output while closed, and only a fixed code when invalid", async () => {
		const root = await directory();
		const diagnostics: Record<string, string>[] = [];
		expect(
			await openRuntimeSafetyEvidenceV1({
				environment: {},
				path: join(root, "safety-evidence.json"),
				logDiagnostic: (entry) => diagnostics.push(entry),
			}),
		).toBeUndefined();
		expect(await readdir(root)).toEqual([]);
		expect(diagnostics).toEqual([]);

		const canary = "canary-window-6d1f";
		expect(
			await openRuntimeSafetyEvidenceV1({
				environment: {
					[runtimeSafetyEvidenceWindowEnvironmentV1]: JSON.stringify({
						...window,
						windowRef: canary,
						unexpected: canary,
					}),
				},
				path: join(root, "safety-evidence.json"),
				logDiagnostic: (entry) => diagnostics.push(entry),
			}),
		).toBeUndefined();
		expect(await readdir(root)).toEqual([]);
		expect(diagnostics).toEqual([
			{
				service: "agent-runtime-host",
				code: "RUNTIME_SAFETY_EVIDENCE_WINDOW_INVALID",
			},
		]);
		expect(JSON.stringify(diagnostics)).not.toContain(canary);
	});
});

describe("evidence log routes on the existing service port (HLD §8.5.6)", () => {
	it("exposes no evidence route while the window is off", async () => {
		const closed = app();
		for (const path of [
			"/internal/runtime/v1/safety-evidence/read",
			"/internal/runtime/v1/safety-evidence/ack",
		]) {
			expect((await post(closed, path, readBody)).status).toBe(404);
			expect((await post(closed, path, readBody, null)).status).toBe(401);
		}
		expect((await closed.request("/healthz")).status).toBe(200);
	});

	it("reads and confirms entries behind the service token only", async () => {
		const assembly = await openRuntimeSafetyEvidenceV1({
			environment: {
				[runtimeSafetyEvidenceWindowEnvironmentV1]: JSON.stringify(window),
			},
			path: join(await directory(), "safety-evidence.json"),
			logDiagnostic: () => {
				throw new Error("unexpected diagnostic");
			},
		});
		if (!assembly) throw new Error("window should be enabled");
		await assembly.log.append(record);
		const open = app(assembly.log);
		expect(
			(
				await post(
					open,
					"/internal/runtime/v1/safety-evidence/read",
					readBody,
					"Bearer other",
				)
			).status,
		).toBe(401);
		const read = await post(
			open,
			"/internal/runtime/v1/safety-evidence/read",
			readBody,
		);
		expect(read.status).toBe(200);
		expect(await read.json()).toEqual({
			schemaVersion: 1,
			entries: [{ cursor: "se1-1", record }],
		});
		for (const invalid of [
			{ ...readBody, capability: "other" },
			{ ...readBody, limit: 101 },
			{ ...readBody, grant: "x" },
		])
			expect(
				(await post(open, "/internal/runtime/v1/safety-evidence/read", invalid))
					.status,
			).toBe(400);
		const future = await post(
			open,
			"/internal/runtime/v1/safety-evidence/ack",
			{
				schemaVersion: 1,
				capability: "runtime-safety-evidence-v1",
				cursor: "se1-2",
			},
		);
		expect(future.status).toBe(409);
		expect(await future.json()).toMatchObject({
			code: "RUNTIME_SAFETY_EVIDENCE_CURSOR_INVALID",
		});
		const ack = await post(open, "/internal/runtime/v1/safety-evidence/ack", {
			schemaVersion: 1,
			capability: "runtime-safety-evidence-v1",
			cursor: "se1-1",
		});
		expect(await ack.json()).toEqual({
			schemaVersion: 1,
			acknowledged: "se1-1",
		});
		expect(
			await (
				await post(open, "/internal/runtime/v1/safety-evidence/read", readBody)
			).json(),
		).toEqual({ schemaVersion: 1, entries: [] });
		await assembly.log.close();
	});
});
