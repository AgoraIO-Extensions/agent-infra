import { RuntimeRelayKeyBindingV1Schema } from "@agent-infra/contracts/runtime";
import {
	type ConversationExecutionAuthorityV1,
	ConversationExecutionError,
	type ConversationExecutionSourceV1,
	conversationExecutionKeySubjectV1,
	isTaskApiChannelV1,
	PersonalApiCredentialErrorV1,
	type PersonalApiTaskAdmissionAuthorityV1,
	parseTaskAuthorizationBoundaryV1,
	resolveCurrentPersonalApiUserV1,
	type TaskApiChannelV1,
	type TaskUserDirectoryV1,
} from "@agent-infra/platform-core";
import type postgres from "postgres";
import { decodeAgentConfigurationRecord } from "./agent-configuration-record.js";
import { readCurrentTaskApplicationV1 } from "./application-task-authorization.js";
import { requireCurrentPersonalApiTaskAdmissionV1 } from "./personal-api-task-authorization.js";
import {
	currentRelayKeyVersionInTransaction,
	type RelayKeyVersionBindingV1,
} from "./relay-key-versions.js";

/** New accept/regeneration only. Replay, supplement and recovery keep the saved binding. */
export async function currentConversationExecutionRelayKeyBindingV1(
	transaction: postgres.TransactionSql,
	input: {
		readonly authority: ConversationExecutionAuthorityV1;
		readonly userDirectory: TaskUserDirectoryV1 | undefined;
		readonly personalApiAdmissionAuthority?: PersonalApiTaskAdmissionAuthorityV1;
	},
): Promise<
	| {
			readonly executionSource: ConversationExecutionSourceV1;
			readonly relayKeyBinding: RelayKeyVersionBindingV1;
	  }
	| { readonly executionSource: null; readonly relayKeyBinding: null }
	| null
> {
	try {
		const authority = input.authority;
		// Existing Web callers without a typed Task boundary retain the legacy
		// V2 execution path.  There is no trusted principal/key binding to pin
		// in that path; treating the missing boundary as unavailable would make
		// the compatibility contract deny every legacy conversation.
		if (!authority.taskBoundary) {
			return { executionSource: null, relayKeyBinding: null };
		}
		const [isolation] = await transaction<{ transaction_isolation: string }[]>`
			show transaction_isolation
		`;
		if (isolation?.transaction_isolation !== "read committed") {
			throw new ConversationExecutionError("unavailable");
		}
		const [agent] = await transaction<
			{
				current_configuration_revision: string;
				authorization_revision: string | null;
				configuration: unknown;
			}[]
		>`
			select agent.current_configuration_revision, agent.authorization_revision,
				configuration.configuration
			from platform.agents agent
			join platform.agent_configuration_revisions configuration
				on configuration.agent_id = agent.id
				and configuration.revision = agent.current_configuration_revision
			where agent.id = ${authority.agentId}
			for share of agent
		`;
		if (!agent) throw new ConversationExecutionError("unavailable");
		const configuration = decodeAgentConfigurationRecord(agent.configuration);
		if (
			configuration.agentId !== authority.agentId ||
			configuration.revision !== Number(agent.current_configuration_revision)
		) {
			throw new ConversationExecutionError("unavailable");
		}
		if (configuration.source.kind === "custom") {
			return { executionSource: null, relayKeyBinding: null };
		}
		const boundary = parseTaskAuthorizationBoundaryV1(authority.taskBoundary);
		if (agent.authorization_revision !== boundary.agentAuthorizationRevision) {
			return null;
		}
		if (boundary.principal.kind === "user") {
			// Protect an absent disable row too, using the existing governance lock order.
			await transaction`lock table platform.platform_user_disables in share mode`;
			const disabled = await transaction<{ user_id: string }[]>`
				select user_id from platform.platform_user_disables
				where user_id = ${authority.actorId}
			`;
			if (disabled.length !== 0) return null;
		}

		const hasCurrentApiAdmission = async (): Promise<boolean> => {
			if (!isTaskApiChannelV1(authority.channelId, boundary.principal))
				return true;
			if (
				input.personalApiAdmissionAuthority?.operation !== "agent:use" ||
				(boundary.principal.kind === "user" && !input.userDirectory)
			) {
				throw new ConversationExecutionError("unavailable");
			}
			const current = await requireCurrentPersonalApiTaskAdmissionV1(
				transaction,
				input.personalApiAdmissionAuthority,
				{
					principal: boundary.principal,
					actorId: authority.actorId,
					agentId: authority.agentId,
					channelId: authority.channelId as TaskApiChannelV1,
					operation: "agent:use",
				},
				input.userDirectory,
			);
			return (
				current.identityRevision === boundary.identityRevision &&
				boundary.accessSources.length === 1 &&
				boundary.accessSources[0]?.kind === "api-use" &&
				current.useGrantRevision === boundary.accessSources[0].useGrantRevision
			);
		};
		if (!(await hasCurrentApiAdmission())) return null;
		const currentPrincipal = () =>
			boundary.principal.kind === "application"
				? readCurrentTaskApplicationV1(transaction, {
						applicationId: boundary.principal.id,
						agentId: boundary.agentId,
					})
				: resolveCurrentPersonalApiUserV1(
						input.userDirectory,
						authority.actorId,
					);
		const firstPrincipal = await currentPrincipal();
		if (!firstPrincipal) return null;
		const subject = conversationExecutionKeySubjectV1(
			authority,
			configuration.source.kind,
			firstPrincipal,
		);
		if (!subject) return null;
		const binding = await currentRelayKeyVersionInTransaction(transaction, {
			purpose: subject.purpose,
			subjectId: subject.subjectId,
		});
		if (!binding) return null;
		// Validate the exact identity conversion against the existing V4 contract.
		RuntimeRelayKeyBindingV1Schema.parse({
			purpose: binding.purpose,
			subjectId: binding.subjectId,
			ciphertextRef: binding.keyId,
			version: binding.keyVersion,
		});
		// Database locks cover local authority; external identity is sampled again
		// after the Key read and must still match the original boundary.
		// API policy samples a fresh database clock after its own final identity read.
		const finalPrincipal = await currentPrincipal();
		if (!finalPrincipal) return null;
		const confirmed = conversationExecutionKeySubjectV1(
			authority,
			configuration.source.kind,
			finalPrincipal,
		);
		if (!confirmed || !(await hasCurrentApiAdmission())) return null;
		return {
			executionSource: subject.executionSource,
			relayKeyBinding: binding,
		};
	} catch (error) {
		if (
			error instanceof PersonalApiCredentialErrorV1 &&
			error.code !== "unavailable" &&
			error.code !== "invalid_input"
		) {
			return null;
		}
		// Do not expose identity, credential, ciphertext or SQL errors to callers.
		throw new ConversationExecutionError("unavailable");
	}
}
