import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	createPaseoApi,
	type PaseoAgent,
	type PaseoAgentTimelineEvent,
	type PaseoAgentTimelineRefetchOptions,
} from "@getpaseo/client";
import { createHostClient } from "@getpaseo/client/node";
import { z } from "zod";

import type { ProviderTemplate } from "./provider-registry.js";

type Failure = "unavailable" | "binding_mismatch" | "acceptance_unknown";

export class PaseoTransportError extends Error {
	constructor(readonly code: Failure) {
		super(code);
	}
}

export type PaseoTransportOptions = {
	thinkingOptionId?: string;
	template: ProviderTemplate;
	model: string;
	cwd: string;
	password?: string;
} & ({ url: string; socketPath?: never } | { socketPath: string; url?: never });

const providers: Record<ProviderTemplate, string> = {
	codex: "codex",
	claude: "claude",
	pi: "pi",
	opencode: "agent-infra-opencode",
};

function localEndpoint(input?: string, socketPath?: string) {
	if (socketPath !== undefined) {
		if (
			input !== undefined ||
			!isAbsolute(socketPath) ||
			!/^\/[a-zA-Z0-9/._-]+$/.test(socketPath)
		)
			throw new PaseoTransportError("binding_mismatch");
		return socketPath;
	}
	if (!input) throw new PaseoTransportError("binding_mismatch");
	const url = URL.parse(input);
	if (
		!url ||
		!["ws:", "wss:"].includes(url.protocol) ||
		!["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
		!["/", "/ws"].includes(url.pathname) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new PaseoTransportError("binding_mismatch");
	}
	// Pass only the validated local address to the SDK's multi-target parser.
	url.hostname = url.hostname === "localhost" ? "127.0.0.1" : url.hostname;
	url.pathname = "/ws";
	return url.href;
}

export class PaseoTransport {
	private readonly daemon;
	private readonly api;
	private readonly provider;
	private readonly model;
	private readonly thinkingOptionId;
	private readonly cwd;

	constructor({
		url,
		socketPath,
		template,
		model,
		thinkingOptionId,
		cwd,
		password,
	}: PaseoTransportOptions) {
		const endpoint = localEndpoint(url, socketPath);
		if (
			!Object.hasOwn(providers, template) ||
			!model.trim() ||
			!isAbsolute(cwd)
		) {
			throw new PaseoTransportError("binding_mismatch");
		}
		this.provider = providers[template];
		this.model = model;
		this.thinkingOptionId = thinkingOptionId;
		this.cwd = cwd;
		this.daemon = createHostClient(endpoint, {
			clientId: randomUUID(),
			clientType: "cli",
			password,
			connectTimeoutMs: 5_000,
			reconnect: { enabled: false },
			logger: { debug() {}, info() {}, warn() {}, error() {} },
		});
		this.api = createPaseoApi(this.daemon);
	}

	async close() {
		try {
			await this.api.dispose();
		} finally {
			await this.daemon.close();
		}
	}

	async probe() {
		await this.connect();
		const deadline = performance.now() + 15_000;
		while (performance.now() < deadline) {
			const snapshot = await safe(
				() => this.api.providers.snapshot({ cwd: this.cwd }),
				"unavailable",
				deadline - performance.now(),
			);
			const entry = snapshot.entries.find(
				(entry) => entry.provider === this.provider,
			);
			if (
				!entry ||
				entry.enabled === false ||
				(this.provider === providers.opencode && entry.source !== "custom")
			)
				return false;
			if (entry.status !== "loading")
				return (
					entry.status === "ready" &&
					entry.models?.some(
						(model) =>
							model.provider === this.provider &&
							model.id === this.model &&
							model.isSelectable !== false,
					) === true
				);
			await delay(Math.min(250, deadline - performance.now()));
		}
		return false;
	}

	private connect() {
		return safe(() => this.daemon.connect());
	}

	private assertBinding(agentId: string, agent: PaseoAgent | null) {
		if (
			!agent ||
			agent.id !== agentId ||
			agent.provider !== this.provider ||
			agent.model !== this.model ||
			agent.cwd !== this.cwd ||
			(this.thinkingOptionId !== undefined &&
				agent.thinkingOptionId !== this.thinkingOptionId) ||
			agent.archivedAt
		) {
			throw new PaseoTransportError("binding_mismatch");
		}
	}

	private async fetchAgent(agentId: string) {
		// The daemon also resolves human-readable prefixes. Only ask for exact IDs.
		if (!z.uuid().safeParse(agentId).success)
			throw new PaseoTransportError("binding_mismatch");
		await this.connect();
		const result = await safe(() => this.api.agents.ref(agentId).refresh());
		if (!result) return null;
		this.assertBinding(agentId, result.agent);
		return result.agent;
	}

	async refetchAgent(agentId: string) {
		return (await this.fetchAgent(agentId)) !== null;
	}

	async ensureAgent(agentId: string) {
		if (await this.refetchAgent(agentId)) return;
		if (!(await this.probe())) throw new PaseoTransportError("unavailable");
		const handle = await safe(
			() =>
				this.api.agents.create({
					agentId,
					idempotencyKey: agentId,
					cwd: this.cwd,
					config: {
						provider: `${this.provider}/${this.model}`,
						thinkingOptionId: this.thinkingOptionId,
					},
				}),
			"acceptance_unknown",
		).catch(async (error: unknown) => {
			// Dispose pending creation observations before a later SDK reconnect can resubmit.
			await this.close();
			throw error;
		});
		this.assertBinding(agentId, handle.current());
	}

	private async existingAgent(agentId: string) {
		if (!(await this.refetchAgent(agentId)))
			throw new PaseoTransportError("unavailable");
		return this.api.agents.ref(agentId);
	}

	async commands(
		agentId: string,
		signal?: AbortSignal,
		revalidate?: () => Promise<void>,
		resumeForInvocation = false,
	) {
		signal?.throwIfAborted();
		const agent = await this.fetchAgent(agentId);
		// Paseo 0.17.4 sets activeTurn (null when idle) on live snapshots only.
		// A fresh daemon reports a persisted agent as closed. Only invocation may resume it.
		if (
			!agent ||
			((agent.activeTurn === undefined || agent.status === "closed") &&
				!(resumeForInvocation && agent.persistence?.sessionId)) ||
			agent.status === "error"
		)
			throw new PaseoTransportError("unavailable");
		signal?.throwIfAborted();
		await revalidate?.();
		signal?.throwIfAborted();
		const result = await safe(() => this.api.agents.ref(agentId).commands());
		if (result.agentId !== agentId)
			throw new PaseoTransportError("binding_mismatch");
		if (result.error) throw new PaseoTransportError("unavailable");
		return result.commands;
	}

	async send(
		agentId: string,
		clientMessageId: string,
		text: string,
		assertCurrent?: () => void,
	) {
		if (!clientMessageId.trim())
			throw new PaseoTransportError("binding_mismatch");
		const handle = await this.existingAgent(agentId);
		assertCurrent?.();
		await safe(
			() => handle.send(text, { messageId: clientMessageId }),
			"acceptance_unknown",
		);
	}

	async timeline(agentId: string, options?: PaseoAgentTimelineRefetchOptions) {
		const handle = await this.existingAgent(agentId);
		const result = await safe(() => handle.timeline.refetch(options));
		if (result.agentId !== agentId)
			throw new PaseoTransportError("binding_mismatch");
		if (result.agent) this.assertBinding(agentId, result.agent);
		return result;
	}

	async subscribe(
		agentId: string,
		handler: (event: PaseoAgentTimelineEvent) => void,
	) {
		const handle = await this.existingAgent(agentId);
		const subscription = await safe(async () =>
			handle.timeline.subscribe((message) => {
				if (message.agentId !== agentId) return;
				const event = message.event;
				if ("provider" in event && event.provider !== this.provider) return;
				switch (event.type) {
					case "error":
						handler({
							agentId,
							event: { type: "error", error: "unavailable" },
						});
						break;
					case "turn_failed":
						if (!("timestamp" in message)) return;
						handler({
							...message,
							event: {
								type: "turn_failed",
								provider: this.provider,
								turnId: event.turnId,
								error: "unavailable",
							},
						});
						break;
					case "turn_canceled":
						if (!("timestamp" in message)) return;
						handler({
							...message,
							event: {
								type: "turn_canceled",
								provider: this.provider,
								turnId: event.turnId,
								reason: "cancelled",
							},
						});
						break;
					case "timeline":
					case "turn_started":
					case "turn_completed":
					case "subscription_restored":
					case "replacement":
						handler(message);
				}
			}),
		);
		const stopListening = this.daemon.subscribeConnectionStatus(
			({ status }) => {
				if (status !== "connected")
					handler({ agentId, event: { type: "error", error: "unavailable" } });
			},
		);
		const release = () => {
			stopListening();
			return safe(() => subscription.release());
		};
		try {
			await safe(() => subscription.ready);
			return release;
		} catch (error) {
			await release();
			throw error;
		}
	}

	async cancel(agentId: string) {
		await this.existingAgent(agentId);
		await safe(() => this.daemon.cancelAgent(agentId), "acceptance_unknown");
	}
}

// Creation lifecycle requests can outlive their socket and have no SDK timeout.
async function safe<T>(
	operation: () => Promise<T>,
	failure: Failure = "unavailable",
	timeoutMs = 15_000,
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			operation(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new PaseoTransportError(failure)),
					timeoutMs,
				);
			}),
		]);
	} catch {
		throw new PaseoTransportError(failure);
	} finally {
		clearTimeout(timer);
	}
}
