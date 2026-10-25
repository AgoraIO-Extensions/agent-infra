import type { WecomSendPortV1 } from "@agent-infra/platform-core";
import type { WecomWebSocketConfigurationV1 } from "@agent-infra/wecom/worker";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	dispatch: vi.fn(),
	queueNoticeTick: vi.fn(async () => false),
	storeOpen: vi.fn(),
	scopeForExecution: vi.fn(),
	channelOptions: undefined as
		| {
				readonly media?: {
					resolve: (...args: never[]) => Promise<unknown>;
				};
		  }
		| undefined,
	mediaOptions: undefined as Record<string, unknown> | undefined,
	mediaResolve: vi.fn(),
	mediaClose: vi.fn(async () => {}),
	outboundLimits: vi.fn(),
	outboundRead: vi.fn(),
	connectionsSend: vi.fn(),
	connectionsPlanMedia: vi.fn(),
	connectionsSendMedia: vi.fn(),
	connectionsUpdate: vi.fn(),
	progressTick: vi.fn(async () => 0),
	progressOptions: undefined as
		| {
				readonly sender: Pick<WecomSendPortV1, "update">;
				readonly answerReferences: unknown;
		  }
		| undefined,
	answerReferences: undefined as unknown,
	sender: undefined as WecomSendPortV1 | undefined,
	close: vi.fn(async () => {}),
	connectionsTick: vi.fn(async () => {}),
	setupTick: vi.fn(async () => {}),
	connectionsClose: vi.fn(async () => {}),
	setupClose: vi.fn(async () => {}),
	connectionBindings: undefined as
		| (() => Promise<readonly WecomWebSocketConfigurationV1[]>)
		| undefined,
	deploymentBindings: vi.fn(
		async (): Promise<readonly WecomWebSocketConfigurationV1[]> => [],
	),
	setupBindings: vi.fn(
		async (): Promise<readonly WecomWebSocketConfigurationV1[]> => [],
	),
}));
vi.mock("@agent-infra/platform-store", () => ({
	PostgresWecomChannelV1: class {
		constructor() {
			mocks.storeOpen();
		}
		close = mocks.close;
		scopeForExecution = mocks.scopeForExecution;
	},
}));
vi.mock("@agent-infra/platform-core", () => ({
	createWecomAuthorizationV1: () => ({}),
	createWecomChannelV1: (options: typeof mocks.channelOptions) => {
		mocks.channelOptions = options;
		return { receive: vi.fn() };
	},
	createWecomDeliveryV1: (options: {
		sender: WecomSendPortV1;
		answerReferences: unknown;
	}) => {
		mocks.sender = options.sender;
		mocks.answerReferences = options.answerReferences;
		return { dispatch: mocks.dispatch };
	},
	createWecomQueueNoticeV1: () => ({
		noted: vi.fn(),
		tick: mocks.queueNoticeTick,
	}),
	createWecomProgressV1: (options: typeof mocks.progressOptions) => {
		mocks.progressOptions = options;
		return { tick: mocks.progressTick };
	},
}));

vi.mock("./wecom-connections.js", () => ({
	createPlatformWecomConnectionsV1: (options: {
		bindings: () => Promise<readonly WecomWebSocketConfigurationV1[]>;
	}) => {
		mocks.connectionBindings = options.bindings;
		return {
			tick: mocks.connectionsTick,
			close: mocks.connectionsClose,
			updater: { update: vi.fn(async () => "sent") },
			sender: {
				send: mocks.connectionsSend,
				update: mocks.connectionsUpdate,
				planMedia: mocks.connectionsPlanMedia,
				sendMedia: mocks.connectionsSendMedia,
			},
		};
	},
}));
vi.mock("./wecom-setup.js", () => ({
	createWecomSetupWorkerV1: () => ({
		tick: mocks.setupTick,
		close: mocks.setupClose,
		bindings: mocks.setupBindings,
	}),
}));
vi.mock("./wecom-media.js", () => ({
	createWecomMediaV1: (options: Record<string, unknown>) => {
		mocks.mediaOptions = options;
		const storage = options.storage as { download?: unknown };
		return {
			inbound: { resolve: mocks.mediaResolve },
			outbound: storage.download
				? {
						limits: mocks.outboundLimits,
						read: mocks.outboundRead,
						withSlot: (work: () => Promise<unknown>) => work(),
					}
				: undefined,
			close: mocks.mediaClose,
		};
	},
	WecomOutboundMediaBusyError: class extends Error {},
}));

import { createPlatformWecomWorkerV1 } from "./wecom-worker.js";

afterEach(() => {
	vi.resetAllMocks();
	mocks.mediaOptions = undefined;
	mocks.progressOptions = undefined;
});

it("assembles the inbound media resolver from the deployment file surface (#3227)", async () => {
	const storage = { upload: vi.fn(), inspect: vi.fn() };
	const worker = createPlatformWecomWorkerV1({
		databaseUrl: "postgres://fixture",
		identity: { resolveSender: async () => null, activeUsers: async () => [] },
		observe: () => {},
		sender: { send: async () => "failed" },
		media: { storage, downloadTimeoutMs: 30_000 },
	});
	try {
		expect(mocks.mediaOptions).toMatchObject({
			databaseUrl: "postgres://fixture",
			storage,
			downloadTimeoutMs: 30_000,
			authorization: expect.any(Object),
		});
		expect(mocks.channelOptions?.media?.resolve).toBe(mocks.mediaResolve);
	} finally {
		await worker.close();
	}
	expect(mocks.mediaClose).toHaveBeenCalledTimes(1);
});

it("keeps the channel media resolver absent when deployment does not provide one", async () => {
	const worker = createPlatformWecomWorkerV1({
		databaseUrl: "postgres://fixture",
		identity: { resolveSender: async () => null, activeUsers: async () => [] },
		observe: () => {},
		sender: { send: async () => "failed" },
	});
	try {
		expect(mocks.channelOptions?.media).toBeUndefined();
		expect(mocks.mediaOptions).toBeUndefined();
	} finally {
		await worker.close();
	}
});

it("rejects unknown channels before querying WeCom execution state", async () => {
	const worker = createPlatformWecomWorkerV1({
		databaseUrl: "postgres://fixture",
		identity: { resolveSender: async () => null, activeUsers: async () => [] },
		observe: () => {},
		sender: { send: async () => "failed" },
	});
	try {
		const record = {
			boundary: { channelId: "partner:channel" },
		} as Parameters<typeof worker.channelAuthorizationCurrent>[0];
		expect(await worker.channelAuthorizationCurrent(record)).toBe(false);
		expect(mocks.scopeForExecution).not.toHaveBeenCalled();
	} finally {
		await worker.close();
	}
});

it("polls Owner setup alongside live connections", async () => {
	const worker = createPlatformWecomWorkerV1({
		databaseUrl: "postgres://fixture",
		identity: { resolveSender: async () => null, activeUsers: async () => [] },
		observe: () => {},
		sender: { send: async () => "failed" },
		connections: {
			bindings: async () => [],
			protectReply: async () => "fixture",
			revealReply: async () => {
				throw new Error("unused");
			},
		},
		setup: {
			decryptor: {
				decrypt: async () => {
					throw new Error("unused");
				},
			},
			directory: { resolveUser: async () => null },
		},
	});
	try {
		await worker.reconcile();
		expect(mocks.setupTick).toHaveBeenCalledOnce();
		expect(mocks.connectionsTick).toHaveBeenCalledOnce();
	} finally {
		await worker.close();
	}
});

it("rejects duplicate deployment and setup bindings by botId", async () => {
	const deployment = [
		{
			botId: "bot-1",
			agentId: "agent-1",
			bindingReference: "deployment",
			credentialVersion: "v1",
			secret: "deployment-secret",
		},
		{
			botId: "bot-2",
			agentId: "agent-2",
			bindingReference: "deployment-2",
			credentialVersion: "v1",
			secret: "deployment-secret-2",
		},
	];
	const setup = {
		botId: "bot-1",
		agentId: "agent-1",
		bindingReference: "setup",
		credentialVersion: "v2",
		secret: "setup-secret",
	};
	mocks.deploymentBindings.mockResolvedValue(deployment);
	mocks.setupBindings.mockResolvedValue([setup]);
	const worker = createPlatformWecomWorkerV1({
		databaseUrl: "postgres://fixture",
		identity: { resolveSender: async () => null, activeUsers: async () => [] },
		observe: () => {},
		sender: { send: async () => "failed" },
		connections: {
			bindings: mocks.deploymentBindings,
			protectReply: async () => "fixture",
			revealReply: async () => {
				throw new Error("unused");
			},
		},
		setup: {
			decryptor: {
				decrypt: async () => {
					throw new Error("unused");
				},
			},
			directory: { resolveUser: async () => null },
		},
	});
	try {
		await expect(mocks.connectionBindings?.()).rejects.toThrow(
			"Invalid WeCom connection bindings",
		);
	} finally {
		await worker.close();
	}
});

it.each([false, true])(
	"bounds a reply batch and settles every claim before returning, rejection=%s",
	async (reject) => {
		const pending = Array.from({ length: 8 }, () =>
			Promise.withResolvers<boolean>(),
		);
		let index = 0;
		mocks.dispatch.mockImplementation(() => pending[index++]?.promise);
		const worker = createPlatformWecomWorkerV1({
			databaseUrl: "postgres://fixture",
			identity: {
				resolveSender: async () => null,
				activeUsers: async () => [],
			},
			observe: () => {},
			sender: { send: async () => "failed" },
		});
		try {
			const result = worker.dispatch();
			const settled = vi.fn();
			void result.then(settled, settled);
			await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledTimes(8));
			if (reject) pending[0]?.reject(new Error("delivery unavailable"));
			else pending[0]?.resolve(true);
			await Promise.resolve();
			expect(settled).not.toHaveBeenCalled();
			for (const item of pending.slice(1)) item.resolve(false);
			if (reject) await expect(result).rejects.toThrow("delivery unavailable");
			else expect(await result).toBe(true);
			expect(mocks.dispatch).toHaveBeenCalledTimes(8);
		} finally {
			for (const item of pending) item.resolve(false);
			await worker.close();
		}
	},
);

it.each(["reconcile", "setup-close", "connections-close"])(
	"continues independent work after %s fails",
	async (mode) => {
		const worker = createPlatformWecomWorkerV1({
			databaseUrl: "postgres://fixture",
			identity: {
				resolveSender: async () => null,
				activeUsers: async () => [],
			},
			observe: () => {},
			sender: { send: async () => "failed" },
			connections: {
				bindings: async () => [],
				protectReply: async () => "fixture",
				revealReply: async () => {
					throw new Error("unused");
				},
			},
			setup: {
				decryptor: {
					decrypt: async () => {
						throw new Error("unused");
					},
				},
				directory: { resolveUser: async () => null },
			},
		});
		if (mode === "reconcile") {
			mocks.connectionsTick.mockRejectedValueOnce(
				new Error("reconcile unavailable"),
			);
			mocks.dispatch.mockResolvedValue(true);
			await expect(worker.reconcile()).rejects.toThrow("reconcile unavailable");
			expect(await worker.dispatch()).toBe(true);
			expect(mocks.dispatch).toHaveBeenCalledTimes(8);
			await worker.close();
		} else {
			(mode === "setup-close"
				? mocks.setupClose
				: mocks.connectionsClose
			).mockRejectedValueOnce(new Error("close unavailable"));
			await expect(worker.close()).rejects.toThrow("close unavailable");
		}
		expect(mocks.setupClose).toHaveBeenCalledTimes(1);
		expect(mocks.connectionsClose).toHaveBeenCalledTimes(1);
		expect(mocks.close).toHaveBeenCalledTimes(1);
	},
);

it("classifies a rejected reply route as failed without calling any external sender", async () => {
	const send = vi.fn(async () => "sent" as const);
	const worker = createPlatformWecomWorkerV1({
		databaseUrl: "postgres://fixture",
		identity: { resolveSender: async () => null, activeUsers: async () => [] },
		observe: () => {},
		sender: { send },
		connections: {
			bindings: async () => [],
			protectReply: async () => "fixture",
			revealReply: async () => {
				throw new Error("invalid route");
			},
		},
	});
	try {
		expect(
			await mocks.sender?.send({
				scope: {
					agentId: "agent",
					bindingReference: "binding",
					kind: "wecom_bot",
					senderId: "sender",
					peerId: "peer",
					conversationType: "single",
					threadId: null,
				},
				replyHandle: "invalid",
				text: "fixture",
			}),
		).toBe("failed");
		expect(send).not.toHaveBeenCalled();
	} finally {
		await worker.close();
	}
});

it("rejects invalid setup deployment before opening a database store", () => {
	expect(() =>
		createPlatformWecomWorkerV1({
			databaseUrl: "postgres://fixture",
			identity: {
				resolveSender: async () => null,
				activeUsers: async () => [],
			},
			observe: () => {},
			sender: { send: async () => "failed" },
			setup: {
				directory: { resolveUser: async () => null },
				decryptor: {
					decrypt: async () => {
						throw new Error("unused");
					},
				},
			},
		}),
	).toThrow("requires a connection deployment");
	expect(mocks.storeOpen).not.toHaveBeenCalled();
});

it.each(["success", "setup", "connections", "store"] as const)(
	"keeps the business pool open until ingress shutdown settles, failure=%s",
	async (mode) => {
		const setup = Promise.withResolvers<void>();
		const connections = Promise.withResolvers<void>();
		const store = Promise.withResolvers<void>();
		const failure = new Error("controlled close failure");
		mocks.setupClose.mockImplementation(() => setup.promise);
		mocks.connectionsClose.mockImplementation(() => connections.promise);
		mocks.close.mockImplementation(() => store.promise);
		const worker = createPlatformWecomWorkerV1({
			databaseUrl: "postgres://fixture",
			identity: {
				resolveSender: async () => null,
				activeUsers: async () => [],
			},
			observe: () => {},
			sender: { send: async () => "failed" },
			connections: {
				bindings: async () => [],
				protectReply: async () => "fixture",
				revealReply: async () => {
					throw new Error("unused");
				},
			},
			setup: {
				decryptor: {
					decrypt: async () => {
						throw new Error("unused");
					},
				},
				directory: { resolveUser: async () => null },
			},
		});
		const closing = worker.close();
		const settled = vi.fn();
		void closing.then(settled, settled);
		try {
			await vi.waitFor(() => {
				expect(mocks.setupClose).toHaveBeenCalledOnce();
				expect(mocks.connectionsClose).toHaveBeenCalledOnce();
			});
			expect(mocks.close).not.toHaveBeenCalled();
			if (mode === "setup") setup.reject(failure);
			else setup.resolve();
			await Promise.resolve();
			expect(mocks.close).not.toHaveBeenCalled();
			if (mode === "connections") connections.reject(failure);
			else connections.resolve();
			await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
			expect(settled).not.toHaveBeenCalled();
			if (mode === "store") store.reject(failure);
			else store.resolve();
			if (mode === "success") await expect(closing).resolves.toBeUndefined();
			else await expect(closing).rejects.toBe(failure);
		} finally {
			setup.resolve();
			connections.resolve();
			store.resolve();
			await closing.catch(() => {});
		}
	},
);

// #3229：只有长连接回复路由且装配了出站文件面时支持媒体；类型与大小按 Channel 当前 FileLimits。
const mediaScope = {
	agentId: "agent",
	bindingReference: "binding",
	kind: "wecom_bot" as const,
	senderId: "sender",
	peerId: "peer",
	conversationType: "single" as const,
	threadId: null,
};
const mediaFile = (fileId: string, mediaType: string, sizeBytes: number) => ({
	fileId,
	name: `${fileId}.bin`,
	mediaType,
	sizeBytes,
	workspaceReference: null,
	kind: "file" as const,
});
function mediaWorker(
	route: Record<string, unknown>,
	storage: Record<string, unknown> = {
		upload: vi.fn(),
		inspect: vi.fn(),
		download: vi.fn(),
	},
) {
	const send = vi.fn(async () => "sent" as const);
	const worker = createPlatformWecomWorkerV1({
		databaseUrl: "postgres://fixture",
		identity: { resolveSender: async () => null, activeUsers: async () => [] },
		observe: () => {},
		sender: { send },
		media: { storage: storage as never },
		connections: {
			bindings: async () => [],
			protectReply: async () => "fixture",
			revealReply: async () => route as never,
		},
	});
	return { worker, send };
}

it("wires the CommonMark reference parser into delivery (#3229)", async () => {
	const { worker } = mediaWorker({ websocket: {} });
	try {
		const parse = mocks.answerReferences as (
			text: string,
		) => readonly { workspaceReference: string | null }[];
		expect(parse("[r](sandbox:out/r.pdf) `[c](sandbox:c)`")).toEqual([
			expect.objectContaining({ workspaceReference: "out/r.pdf" }),
		]);
	} finally {
		await worker.close();
	}
});

it("plans long-connection media against current FileLimits and the connection rate (#3229)", async () => {
	const { worker } = mediaWorker({ websocket: {} });
	try {
		mocks.outboundLimits.mockResolvedValue({
			revision: "r",
			expiresAt: "2099-01-01T00:00:00Z",
			mediaTypes: ["application/pdf", "image/png"],
			maxBytes: 1000,
		});
		mocks.connectionsPlanMedia.mockResolvedValue(["send", "rate_limited"]);
		const files = [
			mediaFile("a", "application/pdf", 10),
			mediaFile("b", "application/zip", 10),
			mediaFile("c", "image/png", 5000),
			mediaFile("d", "image/png", 10),
		];
		expect(
			await mocks.sender?.planMedia?.({
				scope: mediaScope,
				replyHandle: "handle",
				files,
			}),
		).toEqual(["send", "unsupported_type", "exceeds_limit", "rate_limited"]);
		expect(mocks.connectionsPlanMedia).toHaveBeenCalledWith({
			scope: mediaScope,
			replyHandle: "handle",
			files: [files[0], files[3]],
		});
		// 没有声明 FileLimits：不支持媒体。
		mocks.outboundLimits.mockResolvedValueOnce(null);
		expect(
			await mocks.sender?.planMedia?.({
				scope: mediaScope,
				replyHandle: "handle",
				files,
			}),
		).toBeNull();
	} finally {
		await worker.close();
	}
});

it("sends one long-connection media through the outbound file client (#3229)", async () => {
	const { worker } = mediaWorker({ websocket: {} });
	try {
		const bytes = new Uint8Array([1, 2, 3, 4, 5]);
		mocks.outboundRead.mockResolvedValue(bytes);
		mocks.connectionsSendMedia.mockImplementation(
			async (input: { read: (signal: AbortSignal) => Promise<Uint8Array> }) =>
				(await input.read(AbortSignal.timeout(1000))) === bytes
					? "sent"
					: "failed",
		);
		const revalidate = async () => true;
		const source = {
			actorId: "actor",
			conversationId: "conversation",
			executionId: "execution",
		};
		const file = mediaFile("a", "application/pdf", 5);
		expect(
			await mocks.sender?.sendMedia?.({
				scope: mediaScope,
				replyHandle: "handle",
				file,
				source,
				revalidate,
			}),
		).toBe("sent");
		expect(mocks.outboundRead).toHaveBeenCalledWith({
			scope: mediaScope,
			source,
			file,
			revalidate,
			signal: expect.any(AbortSignal),
		});
	} finally {
		await worker.close();
	}
});

it.each([
	[
		"a callback reply route",
		{ responseUrl: "https://qyapi.weixin.qq.com" },
		true,
	],
	["a deployment without object downloads", { websocket: {} }, false],
])(
	"declares media unsupported for %s (#3229 AC-4)",
	async (_name, route, download) => {
		const { worker } = mediaWorker(route, {
			upload: vi.fn(),
			inspect: vi.fn(),
			...(download ? { download: vi.fn() } : {}),
		});
		try {
			expect(
				await mocks.sender?.planMedia?.({
					scope: mediaScope,
					replyHandle: "handle",
					files: [mediaFile("a", "application/pdf", 10)],
				}),
			).toBeNull();
			expect(
				await mocks.sender?.sendMedia?.({
					scope: mediaScope,
					replyHandle: "handle",
					file: mediaFile("a", "application/pdf", 10),
					source: {
						actorId: "actor",
						conversationId: "conversation",
						executionId: "execution",
					},
					revalidate: async () => true,
				}),
			).toBe("failed");
			expect(mocks.outboundLimits).not.toHaveBeenCalled();
			expect(mocks.connectionsPlanMedia).not.toHaveBeenCalled();
			expect(mocks.connectionsSendMedia).not.toHaveBeenCalled();
		} finally {
			await worker.close();
		}
	},
);

// #3376：排队提示与回复批次一起推进；提示失败不影响最终回复的投递结果。
it("ticks long-connection queue notices with every reply batch", async () => {
	const worker = createPlatformWecomWorkerV1({
		databaseUrl: "postgres://fixture",
		identity: {
			resolveSender: async () => null,
			activeUsers: async () => [],
		},
		observe: () => {},
		sender: { send: async () => "failed" },
		connections: {
			bindings: async () => [],
			protectReply: async () => "fixture",
			revealReply: async () => {
				throw new Error("unused");
			},
		},
	});
	try {
		mocks.dispatch.mockResolvedValue(false);
		mocks.queueNoticeTick.mockResolvedValueOnce(true);
		expect(await worker.dispatch()).toBe(true);
		mocks.queueNoticeTick.mockRejectedValueOnce(new Error("notice failed"));
		expect(await worker.dispatch()).toBe(false);
		expect(mocks.queueNoticeTick).toHaveBeenCalledTimes(2);
	} finally {
		await worker.close();
	}
});

// #3377：流式进度只经长连接回复路由覆盖更新；回调模式只发送终态回复。
it("drives streaming progress only through long-connection reply routes (#3377)", async () => {
	const input = {
		scope: {
			agentId: "agent",
			bindingReference: "binding",
			kind: "wecom_bot" as const,
			senderId: "sender",
			peerId: "sender",
			conversationType: "single" as const,
			threadId: null,
		},
		replyHandle: "fixture",
		text: "执行中 · 已用 3 秒",
		prepare: async () => true,
	};
	const websocket = mediaWorker({ websocket: {} });
	try {
		const update = mocks.progressOptions?.sender.update;
		if (!update) throw new Error("Missing progress sender");
		expect(mocks.progressOptions?.answerReferences).toBe(
			mocks.answerReferences,
		);
		mocks.connectionsUpdate.mockResolvedValueOnce("queued");
		expect(await update(input)).toBe("queued");
		expect(mocks.connectionsUpdate).toHaveBeenCalledWith(input);
		mocks.progressTick.mockResolvedValueOnce(2);
		expect(await websocket.worker.progress()).toBe(2);
	} finally {
		await websocket.worker.close();
	}
	mocks.connectionsUpdate.mockClear();
	const callback = mediaWorker({ callback: {} });
	try {
		expect(await mocks.progressOptions?.sender.update?.(input)).toBe("failed");
		expect(mocks.connectionsUpdate).not.toHaveBeenCalled();
	} finally {
		await callback.worker.close();
	}
	mocks.progressOptions = undefined;
	const withoutConnections = createPlatformWecomWorkerV1({
		databaseUrl: "postgres://fixture",
		identity: { resolveSender: async () => null, activeUsers: async () => [] },
		observe: () => {},
		sender: { send: async () => "failed" },
	});
	try {
		expect(mocks.progressOptions).toBeUndefined();
		expect(await withoutConnections.progress()).toBe(0);
	} finally {
		await withoutConnections.close();
	}
});
