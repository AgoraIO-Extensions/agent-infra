import type { AgentConfigurationRecord } from "./agent-configuration-types.js";
import type { PersonalRelayKeyIdentityV1 } from "./personal-relay-key.js";

export class AgentDefaultRelayKeyErrorV1 extends Error {
	constructor(
		readonly code:
			| "invalid_input"
			| "not_authorized"
			| "conflict"
			| "unavailable",
	) {
		super("Agent default Relay Key operation failed");
	}
}

export interface AgentDefaultRelayKeyBindingV1 {
	readonly purpose: "agent-default";
	readonly subjectId: string;
	readonly keyId: string;
	readonly keyVersion: number;
}
export interface AgentDefaultRelayKeyRequestV1 {
	readonly userId: string;
	readonly agentId: string;
	readonly traceId: string;
	readonly requestId: string;
}
export interface AgentDefaultRelayKeyCandidateV1 {
	readonly endpointId: string;
	readonly modelId: string;
	readonly reasoningLevels: readonly string[];
}
export interface AgentDefaultRelayKeyAuditV1
	extends AgentDefaultRelayKeyRequestV1 {
	readonly operation: "replace" | "candidates" | "read";
	readonly outcome: "succeeded" | "rejected" | "failed";
	readonly reason?: AgentDefaultRelayKeyErrorV1["code"];
	readonly configurationRevision?: number;
	readonly previousVersion?: number | null;
	readonly keyVersion?: number | null;
}
export interface AgentDefaultRelayKeyTransactionV1 {
	/** Locks the original Agent configuration and Owner membership, and current disable fact. */
	ownedConfiguration(
		request: AgentDefaultRelayKeyRequestV1,
	): Promise<AgentConfigurationRecord | null>;
	current(agentId: string): Promise<number | null>;
	replace(
		agentId: string,
		expectedVersion: number | null,
		encrypt: (
			binding: AgentDefaultRelayKeyBindingV1,
		) => unknown | Promise<unknown>,
	): Promise<number | null>;
	audit(event: AgentDefaultRelayKeyAuditV1): Promise<void>;
}
export interface AgentDefaultRelayKeyDependenciesV1 {
	readonly transaction: {
		execute<T>(
			work: (transaction: AgentDefaultRelayKeyTransactionV1) => Promise<T>,
		): Promise<T>;
		recordRefusal(event: AgentDefaultRelayKeyAuditV1): Promise<void>;
	};
	readonly currentIdentity: (
		traceId: string,
	) => Promise<PersonalRelayKeyIdentityV1 | null>;
	/** Fresh Key visibility intersected with this exact template/image and current catalog. No cache receipt authorizes a save. */
	readonly candidates: (
		keyValue: string,
		configuration: AgentConfigurationRecord,
	) => Promise<readonly AgentDefaultRelayKeyCandidateV1[]>;
	readonly encrypt: (
		binding: AgentDefaultRelayKeyBindingV1,
		keyValue: string,
	) => unknown | Promise<unknown>;
}
const text = (value: unknown): value is string =>
	typeof value === "string" &&
	value.length > 0 &&
	value.length <= 1024 &&
	!value.includes("\0");
const version = (value: unknown): value is number =>
	Number.isSafeInteger(value) && (value as number) > 0;
const invalid = () => {
	throw new AgentDefaultRelayKeyErrorV1("invalid_input");
};

export function createAgentDefaultRelayKeyUseCaseV1(
	input: AgentDefaultRelayKeyDependenciesV1,
) {
	async function identity(
		request: AgentDefaultRelayKeyRequestV1,
		revision?: string,
	) {
		const current = await input.currentIdentity(request.traceId);
		if (
			!current ||
			current.userId !== request.userId ||
			current.accountStatus !== "active"
		)
			throw new AgentDefaultRelayKeyErrorV1("not_authorized");
		if (
			!text(current.authorizationRevision) ||
			(revision !== undefined && revision !== current.authorizationRevision)
		)
			throw new AgentDefaultRelayKeyErrorV1("unavailable");
		return current.authorizationRevision;
	}
	async function execute<T>(
		request: AgentDefaultRelayKeyRequestV1,
		operation: AgentDefaultRelayKeyAuditV1["operation"],
		work: (
			tx: AgentDefaultRelayKeyTransactionV1,
			configuration: AgentConfigurationRecord,
		) => Promise<{
			result: T;
			audit?: Partial<
				Pick<AgentDefaultRelayKeyAuditV1, "previousVersion" | "keyVersion">
			>;
		}>,
	): Promise<T> {
		if (
			![
				request.userId,
				request.agentId,
				request.traceId,
				request.requestId,
			].every(text)
		)
			invalid();
		const trusted = {
			userId: request.userId,
			agentId: request.agentId,
			traceId: request.traceId,
			requestId: request.requestId,
		};
		try {
			return await input.transaction.execute(async (tx) => {
				const revision = await identity(trusted);
				const configuration = await tx.ownedConfiguration(trusted);
				if (!configuration)
					throw new AgentDefaultRelayKeyErrorV1("not_authorized");
				if (
					configuration.agentId !== trusted.agentId ||
					configuration.source.kind !== "standard" ||
					!configuration.modelConfiguration
				)
					throw new AgentDefaultRelayKeyErrorV1("invalid_input");
				const result = await work(tx, configuration);
				await identity(trusted, revision);
				await tx.audit({
					...trusted,
					operation,
					outcome: "succeeded",
					configurationRevision: configuration.revision,
					...result.audit,
				});
				return result.result;
			});
		} catch (error) {
			const failure =
				error instanceof AgentDefaultRelayKeyErrorV1
					? error
					: new AgentDefaultRelayKeyErrorV1("unavailable");
			try {
				await input.transaction.recordRefusal({
					...trusted,
					operation,
					outcome: failure.code === "unavailable" ? "failed" : "rejected",
					reason: failure.code,
				});
			} catch {
				throw new AgentDefaultRelayKeyErrorV1("unavailable");
			}
			throw failure;
		}
	}
	function parse(value: unknown, replace: boolean) {
		if (!value || typeof value !== "object" || Array.isArray(value))
			return invalid();
		const command = value as Record<string, unknown>;
		const keys = replace
			? ["keyValue", "expectedVersion", "configurationRevision"]
			: ["keyValue", "configurationRevision"];
		if (
			Object.keys(command).length !== keys.length ||
			keys.some((k) => !Object.hasOwn(command, k)) ||
			!version(command.configurationRevision) ||
			typeof command.keyValue !== "string" ||
			!/^[\x21-\x7e]{16,8192}$/.test(command.keyValue) ||
			(replace &&
				command.expectedVersion !== null &&
				!version(command.expectedVersion))
		)
			return invalid();
		return {
			keyValue: command.keyValue,
			configurationRevision: command.configurationRevision,
			expectedVersion: command.expectedVersion as number | null,
		};
	}
	async function candidates(
		key: string,
		configuration: AgentConfigurationRecord,
	) {
		const result = await input.candidates(key, structuredClone(configuration));
		if (
			result.length > 32768 ||
			result.some(
				(option) =>
					!text(option.endpointId) ||
					!text(option.modelId) ||
					option.reasoningLevels.length === 0 ||
					!option.reasoningLevels.every(text),
			)
		)
			throw new AgentDefaultRelayKeyErrorV1("unavailable");
		return result.map(({ endpointId, modelId, reasoningLevels }) => ({
			endpointId,
			modelId,
			reasoningLevels: [...reasoningLevels],
		}));
	}
	return {
		current: (request: AgentDefaultRelayKeyRequestV1) =>
			execute(request, "read", async (tx, configuration) => {
				const keyVersion = await tx.current(request.agentId);
				return {
					result: {
						schemaVersion: 1 as const,
						isSet: keyVersion !== null,
						keyVersion,
						configurationRevision: configuration.revision,
					},
				};
			}),
		candidates(request: AgentDefaultRelayKeyRequestV1, value: unknown) {
			return execute(request, "candidates", async (_tx, configuration) => {
				const command = parse(value, false);
				if (configuration.revision !== command.configurationRevision)
					throw new AgentDefaultRelayKeyErrorV1("conflict");
				return {
					result: {
						schemaVersion: 1 as const,
						configurationRevision: configuration.revision,
						candidates: await candidates(command.keyValue, configuration),
					},
				};
			});
		},
		replace(request: AgentDefaultRelayKeyRequestV1, value: unknown) {
			return execute(request, "replace", async (tx, configuration) => {
				const command = parse(value, true);
				if (
					configuration.revision !== command.configurationRevision ||
					(await tx.current(request.agentId)) !== command.expectedVersion
				)
					throw new AgentDefaultRelayKeyErrorV1("conflict");
				const visible = await candidates(command.keyValue, configuration);
				const model = configuration.modelConfiguration;
				if (
					!model ||
					model.options.some(
						(option) =>
							!visible.some(
								(candidate) =>
									candidate.endpointId === option.endpointId &&
									candidate.modelId === option.modelId &&
									option.reasoningLevels.every((level) =>
										candidate.reasoningLevels.includes(level),
									),
							),
					)
				)
					throw new AgentDefaultRelayKeyErrorV1("invalid_input");
				const keyVersion = await tx.replace(
					request.agentId,
					command.expectedVersion,
					(binding) => input.encrypt(binding, command.keyValue),
				);
				if (keyVersion === null)
					throw new AgentDefaultRelayKeyErrorV1("conflict");
				return {
					result: {
						schemaVersion: 1 as const,
						isSet: true,
						keyVersion,
						configurationRevision: configuration.revision,
					},
					audit: { previousVersion: command.expectedVersion, keyVersion },
				};
			});
		},
	};
}
