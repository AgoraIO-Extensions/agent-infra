import { randomUUID } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeOperationFactV2 } from "@agent-infra/contracts/runtime";
import { afterEach, expect, it, vi } from "vitest";
import * as modelTransport from "./codex-model-transport.js";
import { openPaseoCodexRuntime } from "./paseo-codex-runtime.js";
import * as nativeSession from "./paseo-native-session.js";
import * as pod from "./paseo-pod.js";
import { SessionRuntimeDriver } from "./session-runtime-driver.js";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

it.each(["cold", "restored", "disconnect"] as const)(
	"preserves Codex authorization and transport outcomes for %s",
	async (scenario) => {
		const nativeId = scenario === "restored" ? "paseo:session" : undefined;
		const threadId = randomUUID();
		const bind = vi.fn(async (_id: string) => {});
		const controller = new AbortController();
		const disconnected = new Error("fixture disconnected");
		const facts: RuntimeOperationFactV2[] = [];
		const directory = await realpath(
			await mkdtemp(join(tmpdir(), "codex-cold-request-")),
		);
		roots.push(directory);
		const grant = { relayKey: "fixture-only", revalidate: () => {} };
		const initial = vi.fn(async () => {
			if (scenario === "disconnect") controller.abort(disconnected);
			return grant;
		});
		const ordinary = vi.fn(async () => grant);
		const sessions = vi.spyOn(SessionRuntimeDriver, "open");
		const driver = await openPaseoCodexRuntime({
			path: directory,
			configVersion: "v1",
			defaultModelOptionId: "primary",
			defaultReasoningLevel: "high",
			authorizeInitialModelAction: initial,
			authorizeModelAction: ordinary,
			modelOptions: [
				{
					modelOptionId: "primary",
					model: "test",
					reasoningLevels: ["high"],
					endpoint: "https://example.test/v1",
					authentication: "bearer",
				},
			],
		});
		try {
			const proxy = vi.spyOn(modelTransport, "openCodexModelTransport");
			const boundary = new Error("fixture reached model request");
			vi.spyOn(pod, "openPiPodDaemon").mockResolvedValue({
				socketPath: join(directory, "fixture.sock"),
				password: "fixture-only",
				exited: Promise.withResolvers<void>().promise,
				close: async () => {},
			});
			vi.spyOn(nativeSession, "openPaseoNativeSession").mockImplementation(
				async () => {
					const observer = proxy.mock.calls[0]?.[1];
					if (!observer) throw new Error("missing Codex model observer");
					const context = {
						conversationKey: "session",
						threadId,
						turnId: "turn",
						internalModel: "test",
						reasoningLevel: "high",
					};
					if (scenario === "disconnect") {
						await expect(
							observer.beforeRequest(context, controller.signal),
						).rejects.toBe(disconnected);
						expect(facts.map((fact) => fact.phase)).toEqual([
							"intent",
							"failed",
						]);
						throw boundary;
					}
					for (let i = 0; i < 2; i++) {
						const journal = await observer.beforeRequest(
							context,
							new AbortController().signal,
						);
						expect(journal.credential).toBe(grant.relayKey);
						await journal.started(new Date().toISOString());
						await journal.finish(
							i === 0
								? { phase: "succeeded" }
								: {
										phase: "unknown",
										failureCode:
											scenario === "cold"
												? "invalid_response"
												: "transport_error",
									},
						);
					}
					expect(facts.map((fact) => fact.phase)).toEqual([
						"intent",
						"started",
						"completed",
						"intent",
						"started",
						"unknown",
					]);
					expect(facts.at(-1)?.failureCode).toBe(
						scenario === "cold"
							? "response_incomplete"
							: "dependency_unavailable",
					);
					throw boundary;
				},
			);
			const open = sessions.mock.calls[0]?.[0].openSession;
			if (!open) throw new Error("missing Codex session factory");
			await expect(
				open({
					nativeId,
					codexThread: { expected: nativeId ? threadId : undefined, bind },
					directory,
					cwd: directory,
					executionId: "execution",
					runtimeSessionRef: "session",
					selection: {
						schemaVersion: 1,
						modelOptionId: "primary",
						reasoningLevel: "high",
					},
					modelFact: () => ({
						configVersion: "v1",
						modelId: "test",
						modelOptionId: "primary",
						reasoningLevel: "high",
					}),
					admit: async () => {},
					update: async () => {},
					recordOperationFact: async (fact) => {
						facts.push(fact);
					},
				}),
			).rejects.toBe(boundary);
			if (nativeId) expect(bind).not.toHaveBeenCalled();
			else expect(bind.mock.calls).toEqual([[threadId]]);
			expect(initial).toHaveBeenCalledTimes(nativeId ? 0 : 1);
			expect(ordinary).toHaveBeenCalledTimes(
				{ cold: 1, restored: 2, disconnect: 0 }[scenario],
			);
		} finally {
			await driver.close();
		}
	},
);
it.each([
	"managed_config.toml",
	"hooks.json",
	"auth.json",
	"workspace/.codex",
	"linked-config",
])(
	"rejects persisted SDK trial startup input %s before provider launch",
	async (entry) => {
		const root = await mkdtemp(join(tmpdir(), "codex-trial-startup-"));
		roots.push(root);
		const cwd = join(root, "workspace");
		await mkdir(cwd);
		if (entry === "linked-config")
			await symlink("absent", join(root, "config.toml"));
		else await writeFile(join(root, entry), "synthetic");
		await expect(pod.assertTextOnlyCodexStartup(root, cwd)).rejects.toThrow(
			"RUNTIME_NATIVE_SESSION_UNAVAILABLE",
		);
	},
);
