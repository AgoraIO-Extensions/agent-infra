import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AgentConfigurationRecordV2 } from "./agent-configuration.js";
import { isAgentManagementText } from "./agent-management-input.js";
export type WecomSetupStatusV1 =
	| "awaiting_input"
	| "verifying"
	| "active"
	| "auth_failed"
	| "conflict"
	| "cancelled"
	| "expired";
export interface WecomApplicationCredentialsV1 {
	readonly corporationId: string;
	readonly applicationId: string;
	readonly secret: string;
	readonly token: string;
	readonly encodingAesKey: string;
}
export interface WecomSetupRecordV1 {
	readonly kind?: "wecom_bot" | "wecom_app";
	readonly application?: {
		readonly corporationId: string;
		readonly applicationId: string;
	} | null;
	readonly encryptedCallback?: unknown;
	readonly callbackVerifiedAt?: string | null;
	readonly sessionId: string;
	readonly agentId: string;
	readonly actorId: string;
	readonly configurationRevision: number;
	readonly authorizationRevision: string;
	readonly stateDigest: string;
	readonly expiresAt: string;
	readonly status: WecomSetupStatusV1;
	readonly botId: string | null;
	readonly encryptedCredential: unknown;
	readonly connectionStatus?:
		| "verifying"
		| "connected"
		| "disconnected"
		| "auth_failed";
}
export interface WecomSetupStoreV1 {
	create(record: WecomSetupRecordV1): Promise<void>;
	pendingApplication?(
		agentId: string,
		actorId: string,
	): Promise<WecomSetupRecordV1 | null>;
	read(sessionId: string): Promise<WecomSetupRecordV1 | null>;
	consume(input: {
		readonly session: WecomSetupRecordV1;
		readonly botId: string;
		readonly encryptedCredential: unknown;
		readonly application?: WecomSetupRecordV1["application"];
		readonly encryptedCallback?: unknown;
		readonly connectionStatus?:
			| "verifying"
			| "connected"
			| "disconnected"
			| "auth_failed";
	}): Promise<boolean>;
	cancel(session: WecomSetupRecordV1): Promise<boolean>;
}
export interface WecomSetupAuthorityV1 {
	readonly configuration: AgentConfigurationRecordV2;
	readonly authorizationRevision: string;
}
export class WecomSetupError extends Error {
	constructor(
		readonly code:
			| "unavailable"
			| "stale"
			| "confirmation_required"
			| "invalid",
	) {
		super(`WeCom setup ${code}`);
	}
}
function digest(state: string) {
	return createHash("sha256").update(state).digest("hex");
}
function publicState(record: WecomSetupRecordV1) {
	return {
		sessionId: record.sessionId,
		agentId: record.agentId,
		configurationRevision: record.configurationRevision,
		expiresAt: record.expiresAt,
		status: record.status,
	};
}
export function createWecomSetupV1(options: {
	/** Resolves current company identity and Owner authority, never request-supplied roles. */
	readonly authority: (
		agentId: string,
		actorId: string,
	) => Promise<WecomSetupAuthorityV1 | null>;
	readonly store: WecomSetupStoreV1;
	readonly encrypt: (
		session: WecomSetupRecordV1,
		credential: { readonly botId: string; readonly secret: string },
	) => Promise<unknown>;
	readonly encryptApplication?: (
		session: WecomSetupRecordV1,
		credential: WecomApplicationCredentialsV1,
	) => Promise<{ encryptedCredential: unknown; encryptedCallback: unknown }>;
	readonly now?: () => Date;
}) {
	const now = options.now ?? (() => new Date());
	async function authority(agentId: string, actorId: string) {
		if (!isAgentManagementText(agentId) || !isAgentManagementText(actorId))
			throw new WecomSetupError("invalid");
		const current = await options.authority(agentId, actorId);
		if (
			!current ||
			current.configuration.agentId !== agentId ||
			(current.configuration.source.kind === "custom" &&
				current.configuration.source.interactionMode !== "platform-adapter")
		)
			throw new WecomSetupError("unavailable");
		return current;
	}
	async function owned(agentId: string, actorId: string, sessionId: string) {
		const current = await authority(agentId, actorId);
		const session = await options.store.read(sessionId);
		if (!session || session.agentId !== agentId || session.actorId !== actorId)
			throw new WecomSetupError("unavailable");
		return { current, session };
	}
	return {
		async callback(reference: string) {
			const session = await options.store.read(reference);
			if (
				session?.kind !== "wecom_app" ||
				!session.application ||
				!session.encryptedCallback
			)
				return null;
			const current = await authority(session.agentId, session.actorId);
			if (session.status === "active")
				return current.configuration.channels.some(
					(c) => c.kind === "wecom_app" && c.bindingReference === reference,
				)
					? session
					: null;
			return session.status === "verifying" &&
				Date.parse(session.expiresAt) > now().getTime() &&
				current.configuration.revision === session.configurationRevision &&
				current.authorizationRevision === session.authorizationRevision
				? session
				: null;
		},

		async current(
			agentId: string,
			actorId: string,
			kind: "wecom_bot" | "wecom_app" = "wecom_bot",
		) {
			const current = await authority(agentId, actorId);
			if (kind === "wecom_app" && options.store.pendingApplication) {
				const pending = await options.store.pendingApplication(
					agentId,
					actorId,
				);
				if (
					pending &&
					pending.configurationRevision === current.configuration.revision &&
					pending.authorizationRevision === current.authorizationRevision &&
					Date.parse(pending.expiresAt) > now().getTime()
				)
					return { status: "verifying" as const, sessionId: pending.sessionId };
			}

			const binding = current.configuration.channels.find(
				(c) => c.kind === kind,
			);
			if (!binding) return { status: "not_configured" as const };
			const session = await options.store.read(binding.bindingReference);
			if (!session) return { status: "callback" as const };
			if (session.agentId !== agentId) throw new WecomSetupError("unavailable");
			return {
				...(kind === "wecom_app" ? { sessionId: session.sessionId } : {}),
				status:
					kind === "wecom_app"
						? ("callback" as const)
						: (session.connectionStatus ?? "disconnected"),
			};
		},
		async begin(
			agentId: string,
			actorId: string,
			kind: "wecom_bot" | "wecom_app" = "wecom_bot",
		) {
			if (kind === "wecom_app" && !options.encryptApplication)
				throw new WecomSetupError("unavailable");
			const current = await authority(agentId, actorId);
			const state = randomBytes(32).toString("base64url");
			const session: WecomSetupRecordV1 = {
				sessionId: randomUUID(),
				kind,
				agentId,
				actorId,
				configurationRevision: current.configuration.revision,
				authorizationRevision: current.authorizationRevision,
				stateDigest: digest(state),
				expiresAt: new Date(now().getTime() + 300_000).toISOString(),
				status: "awaiting_input",
				botId: null,
				encryptedCredential: null,
			};
			await options.store.create(session);
			return { ...publicState(session), state };
		},
		async submit(
			input: {
				readonly agentId: string;
				readonly sessionId: string;
				readonly state: string;
				readonly botId: string;
				readonly secret: string;
				readonly takeoverConfirmed: boolean;
			},
			actorId: string,
		) {
			if (
				!isAgentManagementText(input.sessionId) ||
				!isAgentManagementText(input.state) ||
				!isAgentManagementText(input.botId) ||
				!isAgentManagementText(input.secret)
			)
				throw new WecomSetupError("invalid");
			const { current, session } = await owned(
				input.agentId,
				actorId,
				input.sessionId,
			);
			if (
				(session.kind ?? "wecom_bot") !== "wecom_bot" ||
				session.status !== "awaiting_input" ||
				digest(input.state) !== session.stateDigest ||
				Date.parse(session.expiresAt) <= now().getTime()
			)
				throw new WecomSetupError("unavailable");
			if (
				current.configuration.revision !== session.configurationRevision ||
				current.authorizationRevision !== session.authorizationRevision
			)
				throw new WecomSetupError("stale");
			if (input.takeoverConfirmed !== true)
				throw new WecomSetupError("confirmation_required");
			const encryptedCredential = await options.encrypt(session, {
				botId: input.botId,
				secret: input.secret,
			});
			if (
				!(await options.store.consume({
					session,
					botId: input.botId,
					encryptedCredential,
				}))
			)
				throw new WecomSetupError("stale");
			return { ...publicState(session), status: "verifying" as const };
		},

		async submitApplication(
			input: WecomApplicationCredentialsV1 & {
				readonly agentId: string;
				readonly sessionId: string;
				readonly state: string;
			},
			actorId: string,
		) {
			if (!options.encryptApplication) throw new WecomSetupError("unavailable");
			if (
				![
					input.sessionId,
					input.state,
					input.corporationId,
					input.applicationId,
					input.secret,
					input.token,
					input.encodingAesKey,
				].every((v) => isAgentManagementText(v)) ||
				!/^[1-9][0-9]{0,14}$/.test(input.applicationId) ||
				!/^[A-Za-z0-9+/]{43}$/.test(input.encodingAesKey)
			)
				throw new WecomSetupError("invalid");
			const { current, session } = await owned(
				input.agentId,
				actorId,
				input.sessionId,
			);
			if (
				session.kind !== "wecom_app" ||
				session.status !== "awaiting_input" ||
				digest(input.state) !== session.stateDigest ||
				Date.parse(session.expiresAt) <= now().getTime()
			)
				throw new WecomSetupError("unavailable");
			if (
				current.configuration.revision !== session.configurationRevision ||
				current.authorizationRevision !== session.authorizationRevision
			)
				throw new WecomSetupError("stale");
			const encrypted = await options.encryptApplication(session, input);
			if (
				!(await options.store.consume({
					session,
					botId: `app:${digest(JSON.stringify([input.corporationId, input.applicationId]))}`,
					application: {
						corporationId: input.corporationId,
						applicationId: input.applicationId,
					},
					...encrypted,
				}))
			)
				throw new WecomSetupError("stale");
			return { ...publicState(session), status: "verifying" as const };
		},
		async read(agentId: string, actorId: string, sessionId: string) {
			const { session } = await owned(agentId, actorId, sessionId);
			return publicState(session);
		},
		async cancel(agentId: string, actorId: string, sessionId: string) {
			const { session } = await owned(agentId, actorId, sessionId);
			if (!(await options.store.cancel(session)))
				throw new WecomSetupError("stale");
			return { ...publicState(session), status: "cancelled" as const };
		},
	};
}
