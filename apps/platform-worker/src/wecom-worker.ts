import { randomUUID } from "node:crypto";
import {
	createWecomAuthorizationV1,
	createWecomChannelV1,
	createWecomDeliveryV1,
	createWecomQueueNoticeV1,
	sameWecomConnectionAuthorizationFactV1,
	type TaskRuntimeAuthorizationRecordV1,
	type TaskUserDirectoryV1,
	type WecomConnectionAuthorizationPortV1,
	type WecomDeliveryStatusV1,
	type WecomIdentityPortV1,
	type WecomSendPortV1,
} from "@agent-infra/platform-core";
import { PostgresWecomChannelV1 } from "@agent-infra/platform-store";
import { parseWecomAnswerReferencesV1 } from "@agent-infra/wecom/worker";
import {
	createPlatformWecomConnectionsV1,
	type WecomConnectionsDeploymentV1,
} from "./wecom-connections.js";
import {
	createWecomMediaV1,
	type WecomInboundMediaDeploymentV1,
	WecomOutboundMediaBusyError,
} from "./wecom-media.js";
import {
	createWecomSetupWorkerV1,
	type WecomSetupWorkerDeploymentV1,
} from "./wecom-setup.js";

export interface WecomWorkerDeploymentV1 {
	readonly identity: WecomIdentityPortV1;
	readonly connectionAuthorization?: WecomConnectionAuthorizationPortV1;
	readonly userDirectory?: TaskUserDirectoryV1;
	readonly observe: (status: WecomDeliveryStatusV1) => void;
	readonly sender: WecomSendPortV1;
	/**
	 * 智能机器人长连接入站媒体的文件面装配（#3227）。没有时 Core 对入站媒体回复不支持，不调用 Agent。
	 */
	readonly media?: WecomInboundMediaDeploymentV1;
	readonly connections?: WecomConnectionsDeploymentV1;
	readonly setup?: WecomSetupWorkerDeploymentV1;
}

/** Channel transport and replies; Runtime execution stays with the shared conversation Worker. */
export function createPlatformWecomWorkerV1(
	options: WecomWorkerDeploymentV1 & { readonly databaseUrl: string },
) {
	if (options.setup && !options.connections)
		throw new Error("WeCom setup requires a connection deployment");
	const connectionHolderId = randomUUID();
	const store = new PostgresWecomChannelV1({
		connectionHolderId,
		databaseUrl: options.databaseUrl,
		userDirectory: options.userDirectory,
		identity: options.identity,
		connectionAuthorization: options.connectionAuthorization,
		observe: options.observe,
	});
	const authorization = createWecomAuthorizationV1({
		identity: options.identity,
		state: store,
		connectionAuthorization: options.connectionAuthorization,
	});
	const media = options.media
		? createWecomMediaV1({
				...options.media,
				databaseUrl: options.databaseUrl,
				authorization,
				identity: options.identity,
				state: store,
			})
		: undefined;
	const channel = createWecomChannelV1({
		authorization,
		store,
		...(media ? { media: media.inbound } : {}),
	});
	const setup =
		options.setup && options.connections
			? createWecomSetupWorkerV1({
					...options.setup,
					...options.connections,
					databaseUrl: options.databaseUrl,
				})
			: undefined;
	const deployment = options.connections;
	// #3376：排队提示由持有长连接的 Worker 在该消息自己的 stream 上发送与更新。
	let queueNotices: ReturnType<typeof createWecomQueueNoticeV1> | undefined;
	const connections = deployment
		? createPlatformWecomConnectionsV1({
				...options.connections,
				holderId: connectionHolderId,
				bindings: async () => {
					const bindings = [
						...(await deployment.bindings()),
						...((await setup?.bindings()) ?? []),
					];
					if (
						new Set(bindings.map((binding) => binding.botId)).size !==
						bindings.length
					)
						throw new Error("Invalid WeCom connection bindings");
					return bindings;
				},
				databaseUrl: options.databaseUrl,
				receive: channel.receive,
				onQueued: (receiptId, position) =>
					queueNotices?.noted(receiptId, position),
			})
		: undefined;
	if (connections)
		queueNotices = createWecomQueueNoticeV1({
			store,
			sender: connections.updater,
		});
	const outbound = media?.outbound;
	/** 只有长连接回复路由支持媒体；其他回复方式与未装配出站文件面时按不支持处理（#3229）。 */
	const websocketRoute = async (replyHandle: string) => {
		if (!connections || !options.connections) return false;
		const route = await options.connections
			.revealReply(replyHandle)
			.catch(() => null);
		return Boolean(route?.websocket);
	};
	const delivery = createWecomDeliveryV1({
		store,
		authorization,
		answerReferences: parseWecomAnswerReferencesV1,
		sender: {
			async send(input) {
				if (connections && options.connections) {
					const route = await options.connections
						.revealReply(input.replyHandle)
						.catch(() => null);
					if (!route) return "failed";
					if (route.websocket) return connections.sender.send(input);
				}
				return options.sender.send(input);
			},
			async planMedia(input) {
				if (
					!outbound ||
					!connections ||
					!(await websocketRoute(input.replyHandle))
				)
					return null;
				// 没有声明 FileLimits 时按工程 Spec §15.4.1 不发送媒体；类型与大小按当前声明核对。
				const limits = await outbound.limits(input.scope);
				if (!limits) return null;
				const checked = input.files.map((file) =>
					!limits.mediaTypes.includes(file.mediaType)
						? ("unsupported_type" as const)
						: file.sizeBytes > limits.maxBytes
							? ("exceeds_limit" as const)
							: ("send" as const),
				);
				const eligible = input.files.filter(
					(_, index) => checked[index] === "send",
				);
				const reserved = eligible.length
					? await connections.sender.planMedia({ ...input, files: eligible })
					: [];
				if (reserved === null) return null;
				let next = 0;
				return checked.map((plan) =>
					plan === "send" ? (reserved[next++] ?? "rate_limited") : plan,
				);
			},
			async sendMedia(input) {
				if (
					!outbound ||
					!connections ||
					!(await websocketRoute(input.replyHandle))
				)
					return "failed";
				try {
					return await outbound.withSlot(() =>
						connections.sender.sendMedia({
							...input,
							read: (signal) =>
								outbound.read({
									scope: input.scope,
									source: input.source,
									file: input.file,
									revalidate: input.revalidate,
									signal,
								}),
						}),
					);
				} catch (error) {
					// 等待发送槽位超时时还没有外部效果；其他异常无法确认是否已回复。
					return error instanceof WecomOutboundMediaBusyError
						? "failed"
						: "unknown";
				}
			},
		},
	});
	return {
		async reconcile() {
			if (setup) {
				try {
					await setup.tick();
				} catch {
					try {
						options.connections?.observeIngress?.("unavailable");
					} catch {
						/* Observation only. */
					}
				}
			}
			await connections?.tick();
		},
		async dispatch() {
			// Claim a bounded batch so one slow reply cannot serialize all bots.
			const results = await Promise.allSettled([
				...Array.from({ length: 8 }, () => delivery.dispatch()),
				// 位次变化与开始处理的提示；失败只影响提示帧，不影响最终回复。
				...(queueNotices ? [queueNotices.tick().catch(() => false)] : []),
			]);
			const failure = results.find((result) => result.status === "rejected");
			if (failure?.status === "rejected") throw failure.reason;
			return results.some(
				(result) => result.status === "fulfilled" && result.value,
			);
		},
		async channelAuthorizationCurrent(
			record: TaskRuntimeAuthorizationRecordV1,
		) {
			if (!/^wecom_(bot|app):/.test(record.boundary.channelId)) return false;
			const receipt = await store.scopeForExecution(
				record.executionId,
				record.boundary.principal.id,
				record.boundary.channelId,
			);
			if (!receipt) return false;
			const current = await authorization.authorize(
				receipt.scope,
				"use",
				undefined,
				receipt.connectionAuthorizationFact?.providerId,
			);
			return (
				current.outcome === "allowed" &&
				current.authority.actor.actorId === record.boundary.principal.id &&
				current.authority.channelRevision === receipt.channelRevision &&
				sameWecomConnectionAuthorizationFactV1(
					current.authority.connectionAuthorizationFact,
					receipt.connectionAuthorizationFact ?? undefined,
				)
			);
		},
		async close() {
			const results = await Promise.allSettled([
				setup?.close(),
				connections?.close(),
			]);
			// Keep business pools open until setup and connection shutdown settle.
			for (const close of [() => store.close(), () => media?.close()])
				try {
					await close();
				} catch (reason) {
					results.push({ status: "rejected", reason });
				}
			const failure = results.find((result) => result.status === "rejected");
			if (failure?.status === "rejected") throw failure.reason;
		},
	};
}
