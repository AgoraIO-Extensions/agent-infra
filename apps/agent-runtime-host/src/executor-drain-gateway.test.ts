import { generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	codexSessionExecutorBindingDigestV1,
	createCodexSessionExecutorBindingV1,
	issueExecutorStartIdentityV1,
	verifyExecutorStartIdentityV1,
} from "@agent-infra/agent-runtime";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { startExecutorDrainGatewayV1 } from "./executor-drain-gateway.js";
import { openExecutorDrainHostV1 } from "./executor-drain-host.js";
import { openPrivateExecutorV1 } from "./executor-stdio.js";

vi.mock("@agent-infra/agent-runtime", async (original) => ({
	...(await original<typeof import("@agent-infra/agent-runtime")>()),
	probeCodexSessionExecutorStartupV1: vi.fn(),
}));
vi.mock("./executor-stdio.js", () => ({ openPrivateExecutorV1: vi.fn() }));
vi.mock("./executor-process-group.js", () => ({
	trackExecutorDescendantsV1: vi.fn(),
	executorChildrenV1: vi.fn(async () => new Map()),
	executorProcessStartTicksV1: vi.fn(async () => "original-start-ticks"),
	continueExecutorProcessGroupV1: vi.fn(),
	terminateExecutorDescendantsV1: vi.fn(),
	waitForExecutorProcessGroupV1: vi.fn(async () => null),
	waitForExecutorProcessGroupExitV1: vi.fn(async () => true),
	waitForExecutorDescendantsExitV1: vi.fn(async () => true),
}));

it("does not turn transport closure or missing native identity into a rejected-start drain proof", async () => {
	for (const outcome of ["closed", "timeout", "malformed", "ack-lost"]) {
		vi.mocked(openPrivateExecutorV1).mockReturnValue({
			pid: 12345,
			notifications: new Set(),
			close() {},
			async requireLaunchIsolation() {},
			async initialize() {},
			notification() {},
			async request() {
				if (outcome === "timeout")
					throw new Error("CODEX_EXECUTOR_TRANSPORT_UNAVAILABLE");
				if (outcome === "ack-lost") return { id: 1, result: {} };
				return outcome === "closed"
					? { error: { code: -32000 } }
					: { id: 1, error: { code: "unverified" } };
			},
		});
		const directory = await mkdtemp(join(tmpdir(), "executor-rejection-"));
		const binding = createCodexSessionExecutorBindingV1({
			namespace: "regression",
			podName: "sandbox-regression",
			sandboxId: "regression",
			agentId: "agent",
			conversationId: "conversation",
			sessionGeneration: 2,
			resourceFence: 3,
			imageDigest: `registry.example/runtime@sha256:${"a".repeat(64)}`,
		});
		const pair = generateKeyPairSync("ed25519");
		const scope = {
			podUid: "original-pod",
			startupRef: "original-start",
			bindingDigest: codexSessionExecutorBindingDigestV1(binding),
			expiresAt: Date.now() + 60_000,
		};
		const materials = issueExecutorStartIdentityV1(scope, pair.privateKey);
		const identity = (role: "host" | "runner") =>
			verifyExecutorStartIdentityV1(materials[role], {
				...scope,
				role,
				issuerKey: pair.publicKey,
				now: Date.now(),
			});
		const epoch = randomUUID();
		const runner = await startExecutorDrainGatewayV1({
			binding,
			epoch,
			identity: identity("runner"),
			nativeHome: directory,
		});
		const host = await openExecutorDrainHostV1(
			{
				binding,
				epoch,
				async close() {},
				async assertCurrent() {},
				onFailure: () => () => {},
			},
			identity("host"),
			directory,
		);
		let socket: WebSocket | undefined;
		try {
			const drain = host.drain;
			expect(drain).toBeDefined();
			if (!drain) throw new Error("missing drain");
			await drain.arm("original");
			await drain.bindNativeTurn("original", "turn");
			socket = new WebSocket(drain.endpoint());
			await once(socket, "open");
			const reply = once(socket, "message");
			socket.send(
				JSON.stringify({
					id: 1,
					method: "process/start",
					params: {
						processId: "original-handle",
						argv: ["/bin/true"],
						env: {},
					},
				}),
			);
			expect(JSON.parse(String((await reply)[0])).error).toBeDefined();
			expect(await drain.confirm("original")).toBe(false);
			await drain.sealStop("original", "stop-original", 8, Date.now() + 20_000);
			expect(await drain.confirm("original")).toBe(false);
			await expect(drain.arm("next")).rejects.toThrow();
			const files = await readdir(join(directory, "executor-drain"));
			const persisted = JSON.parse(
				await readFile(
					join(directory, "executor-drain", files[0] ?? "missing"),
					"utf8",
				),
			);
			expect(persisted.attempts).toEqual([
				{ protocolSession: expect.any(String), handle: "original-handle" },
			]);
			expect(persisted.confirmed).toBe(false);
		} finally {
			socket?.terminate();
			await host.close();
			await runner.close();
			await rm(directory, { recursive: true, force: true });
		}
	}
});
