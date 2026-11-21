import { generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CodexExecutorDrainJournalV1,
	codexSessionExecutorBindingDigestV1,
	createCodexSessionExecutorBindingV1,
	issueExecutorStartIdentityV1,
	signExecutorControlV1,
	verifyExecutorStartIdentityV1,
} from "@agent-infra/agent-runtime";
import { expect, vi } from "vitest";
import { WebSocket } from "ws";
import { startExecutorDrainGatewayV1 } from "./executor-drain-gateway.js";
import { openExecutorDrainHostV1 } from "./executor-drain-host.js";
import {
	waitForExecutorDescendantsExitV1,
	waitForExecutorProcessGroupExitV1,
	waitForExecutorProcessGroupV1,
} from "./executor-process-group.js";
import { openPrivateExecutorV1 } from "./executor-stdio.js";

const ports = vi.hoisted(() => new Map<number, number>());
// Production ports stay fixed; independent test files use private ephemeral listeners.
vi.mock("node:http", async (original) => {
	const http = await original<typeof import("node:http")>();
	return {
		...http,
		createServer: (...args: Parameters<typeof http.createServer>) => {
			const server = http.createServer(...args);
			const listen = server.listen.bind(server);
			server.listen = ((port: number, host: string, ready: () => void) =>
				port === 8068 || port === 8069
					? listen(0, host, () => {
							const address = server.address();
							if (!address || typeof address === "string")
								throw new Error("missing test listener");
							ports.set(port, address.port);
							ready();
						})
					: listen(port, host, ready)) as typeof server.listen;
			return server;
		},
	};
});

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

export async function executorDriverDrainFixture(
	inputBinding?: Parameters<typeof openExecutorDrainHostV1>[0]["binding"],
) {
	ports.clear();
	const fetch = globalThis.fetch;
	let foreignDigest: string | undefined;
	const redirected = vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async (input, init) => {
			const url = new URL(String(input));
			const port = ports.get(Number(url.port));
			if (!port || url.hostname !== "127.0.0.1")
				throw new Error("unexpected test destination");
			url.port = String(port);
			const response = await fetch(url, init);
			if (foreignDigest && url.pathname === "/control/drain" && response.ok) {
				const packet = (await response.json()) as {
					requestId: string;
					deadline: number;
					contents: Record<string, unknown>;
				};
				return Response.json(
					signExecutorControlV1(
						identity("runner"),
						"/control/drain/result",
						{
							...packet.contents,
							digest: foreignDigest,
							executionId: "foreign-completed",
						},
						packet.requestId,
						packet.deadline,
					),
				);
			}
			return response;
		});
	let proved = false;
	const toolStart = vi.fn(async (_method: string, _params: unknown) => ({
		id: 1,
		result: {},
	}));
	vi.mocked(waitForExecutorProcessGroupV1).mockResolvedValue({
		leader: 54321,
		parent: 12345,
		parentStartTicks: "original-start-ticks",
		startTicks: "tool-start",
	});
	vi.mocked(waitForExecutorProcessGroupExitV1).mockImplementation(
		async () => proved,
	);
	vi.mocked(waitForExecutorDescendantsExitV1).mockImplementation(
		async () => proved,
	);
	vi.mocked(openPrivateExecutorV1).mockReturnValue({
		pid: 12345,
		notifications: new Set(),
		close() {},
		async requireLaunchIsolation() {},
		async initialize() {},
		notification() {},
		request: toolStart,
	});
	const directory = await mkdtemp(join(tmpdir(), "executor-rejection-"));
	const binding =
		inputBinding ??
		createCodexSessionExecutorBindingV1({
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

	const drain = host.drain;
	if (!drain) throw Error("missing drain");
	let socket: WebSocket | undefined;
	let connected: Promise<unknown> | undefined;
	let requestId = 0;
	const admission = () => host;
	return {
		directory,
		admission,
		toolStart,
		async launch(handle: string) {
			if (!socket) {
				socket = new WebSocket(
					drain.endpoint().replace(":8068", `:${ports.get(8068)}`),
				);
				connected = once(socket, "open");
			}
			await connected;
			const id = ++requestId;
			const ws = socket;
			const response = new Promise<unknown>((resolve) => {
				const receive = (bytes: unknown) => {
					const v = JSON.parse(String(bytes));
					if (v.id === id) {
						ws.off("message", receive);
						resolve(v);
					}
				};
				ws.on("message", receive);
			});
			socket.send(
				JSON.stringify({
					id,
					method: "process/start",
					params: { processId: handle, argv: ["/bin/true"], env: {} },
				}),
			);
			expect(await response).not.toHaveProperty("error");
		},
		async foreignCompletion() {
			const journal = await CodexExecutorDrainJournalV1.open(
				join(directory, "foreign.json"),
				{
					executionId: "foreign-completed",
					podUid: scope.podUid,
					generation: binding.sessionGeneration,
					resourceFence: binding.resourceFence,
					epoch,
				},
			);
			try {
				await journal.bindNativeTurn("foreign-turn");
				const stop = { stopRequestId: "foreign-stop", stopFence: 3 };
				const inventory = await journal.seal(stop);
				expect(
					await journal.confirm(stop, inventory.digest, {
						verifiedAt: Date.now(),
						groups: [],
					}),
				).toBe(true);
				foreignDigest = inventory.digest;
				proved = true;
			} finally {
				await journal.close();
			}
		},
		prove() {
			foreignDigest = undefined;
			proved = true;
		},
		disconnect() {
			socket?.terminate();
			socket = undefined;
		},
		async close() {
			socket?.terminate();
			await host.close();
			await runner.close();
			await rm(directory, { recursive: true, force: true });
			redirected.mockRestore();
		},
	};
}
