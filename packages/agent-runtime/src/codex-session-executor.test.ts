import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CodexSessionExecutorAdmissionV1,
	codexSessionExecutorAttestationV1,
	codexSessionExecutorBindingDigestV1,
	createCodexSessionExecutorBindingV1,
	openCodexSessionExecutorAdmissionV1,
	parseCodexSessionExecutorBindingV1,
	pinCodexSessionExecutorEpochV1,
	verifyCodexSessionExecutorBindingV1,
} from "./codex-session-executor.js";

const token = "synthetic-session-service-token-3054";
const binding = createCodexSessionExecutorBindingV1({
	namespace: "runtime-test",
	podName: "sandbox-a",
	agentId: "agent-a",
	conversationId: "conversation-a",
	sessionGeneration: 2,
	sandboxId: "a",
	resourceFence: 3,
	imageDigest: `registry.example.test/runtime@sha256:${"a".repeat(64)}`,
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function statusSource() {
	const state: {
		schemaVersion: number;
		podUid: string;
		epoch: string;
		bindingDigest: string;
		ready: boolean;
	} = {
		schemaVersion: 1,
		podUid: "pod-uid",
		epoch: randomUUID(),
		bindingDigest: codexSessionExecutorBindingDigestV1(binding),
		ready: true,
	};
	let ended = false;
	let breakStream: (() => void) | undefined;
	const fetcher: typeof fetch = async (url) => {
		if (String(url).endsWith("/status")) return Response.json(state);
		if (!String(url).endsWith("/lifetime"))
			throw new Error("unexpected endpoint");
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					const emit = () =>
						controller.enqueue(
							new TextEncoder().encode(`${JSON.stringify(state)}\n`),
						);
					emit();
					const timer = setInterval(emit, 25);
					breakStream = () => {
						if (!ended) {
							ended = true;
							clearInterval(timer);
							controller.close();
						}
					};
					cleanups.push(async () => {
						breakStream?.();
					});
				},
				cancel() {
					breakStream?.();
				},
			}),
		);
	};
	return { state, fetcher, disconnect: () => breakStream?.() };
}

describe("Codex Session executor authority", () => {
	it("binds the same Conversation generation workspace used by the native bridge", () => {
		const key = createHash("sha256")
			.update(JSON.stringify(["agent-a", "conversation-a", 2]))
			.digest("hex");
		expect(binding.workspaceRoot).toBe(
			`/workspace/runtime/codex-driver.json.native/conversations/${key}/workspace`,
		);
		for (const changed of [
			{ workspaceRoot: "/workspace" },
			{ workspaceSubPath: "runtime" },
			{ conversationKey: "b".repeat(64) },
			{ podName: "sandbox-foreign" },
			{ unexpected: true },
		])
			expect(() =>
				parseCodexSessionExecutorBindingV1({ ...binding, ...changed }),
			).toThrow("CODEX_SESSION_EXECUTOR_INVALID");
	});
	it("rejects a valid MAC reused for a different Agent, generation or fence", () => {
		const mac = codexSessionExecutorAttestationV1(binding, token);
		expect(verifyCodexSessionExecutorBindingV1(binding, mac, token)).toEqual(
			binding,
		);
		for (const changed of [
			{ agentId: "foreign-agent" },
			{ conversationId: "foreign-conversation" },
			{ sessionGeneration: 3 },
			{ resourceFence: 4 },
		]) {
			const other = createCodexSessionExecutorBindingV1({
				...binding,
				...changed,
			});
			expect(() =>
				verifyCodexSessionExecutorBindingV1(other, mac, token),
			).toThrow();
		}
		expect(() =>
			verifyCodexSessionExecutorBindingV1(
				binding,
				mac,
				"synthetic-foreign-service-token",
			),
		).toThrow();
	});
	it("pins the live Pod and epoch and never recovers a poisoned admission", async () => {
		const source = statusSource();
		const admission = await openCodexSessionExecutorAdmissionV1(
			binding,
			"pod-uid",
			{ fetch: source.fetcher, pollIntervalMs: 10000 },
		);
		cleanups.push(() => admission.close());
		await admission.assertCurrent();
		const observed: string[] = [];
		admission.onFailure(() => {
			observed.push("first");
			void admission.close();
		});
		admission.onFailure(() => observed.push("second"));
		source.state.epoch = randomUUID();
		await expect(admission.assertCurrent()).rejects.toThrow();
		expect(observed).toEqual(["first", "second"]);
		source.state.epoch = admission.epoch;
		await expect(admission.assertCurrent()).rejects.toThrow();
	});
	it("rejects a disconnected lifetime even when status returns the old epoch", async () => {
		const source = statusSource();
		const admission = await openCodexSessionExecutorAdmissionV1(
			binding,
			"pod-uid",
			{ fetch: source.fetcher },
		);
		cleanups.push(() => admission.close());
		const failed = new Promise<void>((resolve) => admission.onFailure(resolve));
		source.disconnect();
		await failed;
		await expect(admission.assertCurrent()).rejects.toThrow();
	});
	it("rejects a status response that arrives after the pinned lifetime failed", async () => {
		const source = statusSource();
		let hold = false;
		let release: (() => void) | undefined;
		const fetcher: typeof fetch = async (url, options) => {
			const response = await source.fetcher(url, options);
			if (hold && String(url).endsWith("/status"))
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			return response;
		};
		const admission = await openCodexSessionExecutorAdmissionV1(
			binding,
			"pod-uid",
			{ fetch: fetcher, pollIntervalMs: 10000 },
		);
		cleanups.push(() => admission.close());
		hold = true;
		const pending = admission.assertCurrent();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const failed = new Promise<void>((resolve) => admission.onFailure(resolve));
		source.disconnect();
		await failed;
		release?.();
		await expect(pending).rejects.toThrow();
	});
	it("refuses startup with foreign Pod or binding identity", async () => {
		const source = statusSource();
		await expect(
			openCodexSessionExecutorAdmissionV1(binding, "foreign-pod", {
				fetch: source.fetcher,
				startupTimeoutMs: 0,
			}),
		).rejects.toThrow();
		source.state.bindingDigest = "a".repeat(64);
		await expect(
			openCodexSessionExecutorAdmissionV1(binding, "pod-uid", {
				fetch: source.fetcher,
				startupTimeoutMs: 0,
			}),
		).rejects.toThrow();
	});
	it("preserves the epoch across Host restarts and rejects a symlink pin", async () => {
		const directory = await mkdtemp(join(tmpdir(), "executor-epoch-"));
		cleanups.push(() => rm(directory, { recursive: true, force: true }));
		const admission: CodexSessionExecutorAdmissionV1 = {
			binding,
			epoch: randomUUID(),
			assertCurrent: async () => {},
			onFailure: () => () => {},
			close: async () => {},
		};
		await pinCodexSessionExecutorEpochV1(directory, admission);
		await pinCodexSessionExecutorEpochV1(directory, admission);
		await expect(
			pinCodexSessionExecutorEpochV1(directory, {
				...admission,
				epoch: randomUUID(),
			}),
		).rejects.toThrow();
		const pin = join(
			directory,
			`.executor-${codexSessionExecutorBindingDigestV1(binding)}.json`,
		);
		const contents = await readFile(pin, "utf8");
		const other = await mkdtemp(join(tmpdir(), "executor-epoch-link-"));
		cleanups.push(() => rm(other, { recursive: true, force: true }));
		await symlink(
			pin,
			join(
				other,
				`.executor-${codexSessionExecutorBindingDigestV1(binding)}.json`,
			),
		);
		await expect(
			pinCodexSessionExecutorEpochV1(other, admission),
		).rejects.toThrow();
		expect(await readFile(pin, "utf8")).toBe(contents);
	});
});
