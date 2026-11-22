import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeSafetyEvidenceWindowV1 } from "@agent-infra/contracts/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { DurableJsonFile } from "./durable-json.js";
import {
	RuntimeSafetyEvidenceLogV1,
	runtimeSafetyEvidenceWindowAdmitsV1,
} from "./safety-evidence-log.js";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) {
		await chmod(directory, 0o700).catch(() => undefined);
		await rm(directory, { recursive: true, force: true });
	}
});

async function directory() {
	const created = await mkdtemp(join(tmpdir(), "runtime-safety-evidence-"));
	directories.push(created);
	return created;
}

const record = (evidenceId = "evidence-1", challengeRef = evidenceId) => ({
	schemaVersion: 1,
	code: "RUNTIME_ISOLATION_EVIDENCE_V1",
	kind: "isolation_observation",
	binding: {
		evidenceId,
		scenario: { id: "u1-file", version: 1 },
		windowRef: "window-1",
		challengeRef,
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
		observedAt: "2026-11-22T00:00:00.000Z",
		clockId: "clock-1",
		sequence: 1,
	},
	resourceClass: "file",
	actionClass: "read",
	targetScope: "foreign",
	resultClass: "denied",
	nativeObserved: true,
	failureClass: "permission_denied",
});

describe("Host safety evidence log (Spec §18.5.1 载体与版本, HLD §8.5.6)", () => {
	it("hands over only committed entries after the confirmed cursor", async () => {
		const path = join(await directory(), "safety-evidence.json");
		const log = await RuntimeSafetyEvidenceLogV1.open({ path });
		expect(await log.append(record("evidence-1"))).toBe("appended");
		expect(await log.append(record("evidence-2"))).toBe("appended");
		const entries = await log.read({ after: null, limit: 10 });
		expect(entries.map((entry) => entry.cursor)).toEqual(["se1-1", "se1-2"]);
		expect(await log.read({ after: "se1-1", limit: 10 })).toEqual([entries[1]]);
		expect(await log.acknowledge("se1-1")).toBe("se1-1");
		expect(
			(await log.read({ after: null, limit: 10 })).map((entry) => entry.cursor),
		).toEqual(["se1-2"]);
		await log.close();
	});

	it("resumes after a restart without losing or repeating entries", async () => {
		const path = join(await directory(), "safety-evidence.json");
		const first = await RuntimeSafetyEvidenceLogV1.open({ path });
		await first.append(record("evidence-1"));
		await first.append(record("evidence-2"));
		await first.acknowledge("se1-1");
		await first.close();

		const second = await RuntimeSafetyEvidenceLogV1.open({ path });
		expect(await second.read({ after: null, limit: 10 })).toEqual([
			{ cursor: "se1-2", record: record("evidence-2") },
		]);
		// A redelivered ACK of an older cursor returns the confirmed one, nothing reappears.
		expect(await second.acknowledge("se1-1")).toBe("se1-1");
		expect(await second.append(record("evidence-3"))).toBe("appended");
		expect(
			(await second.read({ after: null, limit: 10 })).map(
				(entry) => entry.cursor,
			),
		).toEqual(["se1-2", "se1-3"]);
		await second.close();
	});

	it("advances the ACK only to a cursor it has durably committed", async () => {
		const path = join(await directory(), "safety-evidence.json");
		const log = await RuntimeSafetyEvidenceLogV1.open({ path });
		await log.append(record("evidence-1"));
		for (const cursor of ["se1-2", "se1-99", "1", "se1-01", "se1--1", "other"])
			await expect(log.acknowledge(cursor)).rejects.toMatchObject({
				code: "RUNTIME_SAFETY_EVIDENCE_CURSOR_INVALID",
				httpStatus: 409,
			});
		await expect(log.read({ after: "se1-5", limit: 10 })).rejects.toMatchObject(
			{ code: "RUNTIME_SAFETY_EVIDENCE_CURSOR_INVALID" },
		);
		expect(JSON.parse(await readFile(path, "utf8")).acknowledged).toBe(0);
		expect(await log.acknowledge("se1-1")).toBe("se1-1");
		expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
			acknowledged: 1,
			entries: [],
		});
		await log.close();
	});

	it("applies backpressure without failing the producer", async () => {
		const path = join(await directory(), "safety-evidence.json");
		const log = await RuntimeSafetyEvidenceLogV1.open({ path, capacity: 2 });
		expect(await log.append(record("evidence-1"))).toBe("appended");
		expect(await log.append(record("evidence-2"))).toBe("appended");
		expect(await log.append(record("evidence-3"))).toBe("full");
		await log.acknowledge("se1-1");
		expect(await log.append(record("evidence-3"))).toBe("appended");
		await log.close();
	});

	it("reports a write failure as unavailable and leaves other durable state untouched", async () => {
		const root = await directory();
		const evidenceDirectory = join(root, "evidence");
		const log = await RuntimeSafetyEvidenceLogV1.open({
			path: join(evidenceDirectory, "safety-evidence.json"),
		});
		// Business state lives in its own file, as the Host journal does.
		const business = await DurableJsonFile.open(join(root, "host.json"), {
			events: 0,
		});
		await chmod(evidenceDirectory, 0o500);
		await expect(log.append(record("evidence-1"))).resolves.toBe("unavailable");
		await expect(log.append(record("evidence-2"))).resolves.toBe("unavailable");
		await expect(log.read({ after: null, limit: 10 })).rejects.toMatchObject({
			code: "RUNTIME_SAFETY_EVIDENCE_UNAVAILABLE",
			httpStatus: 503,
		});
		await business.update((state) => {
			state.events++;
		});
		expect(business.read()).toEqual({ events: 1 });
		await chmod(evidenceDirectory, 0o700);
		await log.close();
		await business.close();
	});

	it("refuses a record this Host may not hand over and keeps it out of the file", async () => {
		const path = join(await directory(), "safety-evidence.json");
		const log = await RuntimeSafetyEvidenceLogV1.open({ path });
		const canary = "canary-7f3e-private-body";
		for (const invalid of [
			{ ...record(), resultClass: "allowed", note: canary },
			{ ...record(), kind: "control_observation", body: canary },
			{ text: canary },
		])
			expect(await log.append(invalid)).toBe("invalid");
		expect(await readFile(path, "utf8")).not.toContain(canary);
		expect(await log.read({ after: null, limit: 10 })).toEqual([]);
		await log.close();
	});

	it("refuses to open a tampered log", async () => {
		const path = join(await directory(), "safety-evidence.json");
		const log = await RuntimeSafetyEvidenceLogV1.open({ path });
		await log.append(record());
		await log.close();
		const tampered = JSON.parse(await readFile(path, "utf8"));
		tampered.acknowledged = 5;
		const { writeFile } = await import("node:fs/promises");
		await writeFile(path, JSON.stringify(tampered));
		await expect(RuntimeSafetyEvidenceLogV1.open({ path })).rejects.toThrow(
			"RUNTIME_SAFETY_EVIDENCE_LOG_INVALID",
		);
	});
});

describe("window membership (HLD §8.5.6 step 1)", () => {
	const window: RuntimeSafetyEvidenceWindowV1 = {
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
	const inside = new Date("2026-11-22T01:00:00.000Z");

	it("admits only the window's subjects and Agents while it is open", () => {
		const admits = (change: Record<string, unknown> = {}) =>
			runtimeSafetyEvidenceWindowAdmitsV1({
				window,
				agentId: "agent-1",
				principalRef: "p1-principal",
				now: inside,
				...change,
			});
		expect(admits()).toBe(true);
		expect(admits({ agentId: "agent-2" })).toBe(false);
		expect(admits({ principalRef: "p1-other" })).toBe(false);
		expect(admits({ now: new Date("2026-11-22T02:00:01.000Z") })).toBe(false);
		expect(admits({ now: new Date("2026-11-21T23:59:59.000Z") })).toBe(false);
		expect(admits({ window: undefined })).toBe(false);
	});
});
