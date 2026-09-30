import { PassThrough } from "node:stream";
import type {
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionNotification,
} from "@agentclientprotocol/sdk";
import { expect, it, vi } from "vitest";
import { openAcpSession } from "./acp-session.js";

const protocol = vi.hoisted(() => ({
	permission:
		vi.fn<
			(input: {
				params: RequestPermissionRequest;
			}) => Promise<RequestPermissionResponse>
		>(),
	update: vi.fn<(input: { params: SessionNotification }) => Promise<void>>(),
	close: vi.fn(),
}));
vi.mock("@agentclientprotocol/sdk", async (importOriginal) => ({
	...(await importOriginal<typeof import("@agentclientprotocol/sdk")>()),
	PROTOCOL_VERSION: 1,
	client: () => {
		const connection = {
			onNotification: (_method: string, callback: typeof protocol.update) => {
				protocol.update.mockImplementation(callback);
				return connection;
			},
			onRequest: (_method: string, callback: typeof protocol.permission) => {
				protocol.permission.mockImplementation(callback);
				return connection;
			},
			connect: () => connection,
			close: protocol.close,
			agent: {
				request: async (method: string) =>
					method === "initialize"
						? { protocolVersion: 1, agentCapabilities: { loadSession: true } }
						: { sessionId: "native", configOptions: [] },
			},
		};
		return connection;
	},
}));
vi.mock("./acp-process.js", () => ({
	spawnAcpProcess: async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		return {
			child: { stdin, stdout },
			exited: Promise.resolve(),
			close: async () => {
				stdin.destroy();
				stdout.destroy();
			},
		};
	},
}));

it.each(["close", "completed"] as const)(
	"denies a late durable permission after %s",
	async (race) => {
		let entered: () => void = () => {};
		const factEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release: () => void = () => {};
		const factRelease = new Promise<void>((resolve) => {
			release = resolve;
		});
		const session = await openAcpSession({
			directory: "/unused",
			cwd: "/unused",
			launch: {
				command: "unused",
				args: [],
				env: {},
				authorize: async () => true,
			},
			update: async () => {},
			toolRequestStarted: async () => {
				entered();
				await factRelease;
			},
		});
		let closing: Promise<void> | undefined;
		try {
			await protocol.update({
				params: {
					sessionId: "native",
					update: {
						sessionUpdate: "tool_call",
						toolCallId: "tool",
						title: "Read synthetic file",
						kind: "read",
						status: "pending",
					},
				},
			});
			const permission = protocol.permission({
				params: {
					sessionId: "native",
					toolCall: { toolCallId: "tool", kind: "read", status: "pending" },
					options: [
						{ optionId: "allow", kind: "allow_once", name: "Allow" },
						{ optionId: "reject", kind: "reject_once", name: "Reject" },
					],
				},
			});
			await factEntered;
			if (race === "close") closing = session.close();
			else
				await protocol.update({
					params: {
						sessionId: "native",
						update: {
							sessionUpdate: "tool_call_update",
							toolCallId: "tool",
							status: "completed",
						},
					},
				});
			release();
			expect(await permission).toEqual({
				outcome: { outcome: "selected", optionId: "reject" },
			});
			await closing;
		} finally {
			release();
			await session.close();
		}
	},
);
