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
import { afterEach, expect, it, vi } from "vitest";
import * as modelTransport from "./codex-model-transport.js";
import { openPaseoCodexRuntime } from "./paseo-codex-runtime.js";
import * as pod from "./paseo-pod.js";
import { SessionRuntimeDriver } from "./session-runtime-driver.js";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

it.each([undefined, "restored-native-id"])(
	"chooses first model authorization at the Codex request boundary with nativeId=%s",
	async (nativeId) => {
		const directory = await realpath(
			await mkdtemp(join(tmpdir(), "codex-cold-request-")),
		);
		roots.push(directory);
		const grant = { relayKey: "fixture-only", revalidate: () => {} };
		const initial = vi.fn(async () => grant);
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
			proxy.mockImplementation(async (_routes, observer) => {
				const context = {
					conversationKey: "session",
					threadId: "thread",
					turnId: "turn",
					internalModel: "test",
					reasoningLevel: "high",
				};
				for (let i = 0; i < 2; i++) {
					const journal = await observer.beforeRequest(
						context,
						new AbortController().signal,
					);
					expect(journal.credential).toBe(grant.relayKey);
				}
				throw boundary;
			});
			const open = sessions.mock.calls[0]?.[0].openSession;
			if (!open) throw new Error("missing Codex session factory");
			await expect(
				open({
					nativeId,
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
					recordOperationFact: async () => {},
				}),
			).rejects.toBe(boundary);
			expect(initial).toHaveBeenCalledTimes(nativeId ? 0 : 1);
			expect(ordinary).toHaveBeenCalledTimes(nativeId ? 2 : 1);
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
