import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	EvaluationDataErrorV1,
	type EvaluationFileBindingV1,
	type EvaluationPolicyV1,
	type EvaluationTaskBindingV1,
	isEvaluationFileRuntimeCurrentV1,
	parseEvaluationExperimentPolicyV1,
	parseEvaluationGrantV1,
	parseEvaluationPolicyV1,
	parseEvaluationVersionV1,
	parseTaskAuthorizationBoundaryV1,
	type TaskAuthorizationBoundaryV1,
	type TaskPrincipalV1,
	type TaskUserDirectoryV1,
} from "@agent-infra/platform-core";
import type postgres from "postgres";
import { decodeVersionedAgentConfigurationRecord } from "./agent-configuration-record.js";
import { requireCurrentEvaluationAdmissionV1 } from "./evaluation-task-admission.js";
import postgresClient from "./observed-postgres.js";
import { decodePersistedWorkloadStateV1 } from "./workload-reconciliation.js";

/** Current facts inside the existing Task transaction, never a second authority database. */
export async function requireCurrentEvaluationTaskV1(
	tx: postgres.TransactionSql,
	boundary: TaskAuthorizationBoundaryV1,
	loadPolicy: EvaluationCurrentPolicyReaderV1,
) {
	const binding = boundary.evaluation;
	if (boundary.channelId !== "eval" || !binding)
		throw new EvaluationDataErrorV1("denied");
	const policy = parseEvaluationPolicyV1(await loadPolicy.data());
	const experimentPolicy = parseEvaluationExperimentPolicyV1(
		await loadPolicy.experiment(),
	);
	const [experimentCheckpoint] = await tx<
		{ revision: string; digest: string }[]
	>`select revision,digest from platform.evaluation_policies where id='experiment' for share`;
	const variant = experimentPolicy.variants.find(
		(v) => v.variantId === binding.variantId,
	);
	if (
		!experimentCheckpoint ||
		experimentPolicy.policyId !== policy.policyId ||
		experimentPolicy.revision !== policy.revision ||
		+experimentCheckpoint.revision !== experimentPolicy.revision ||
		experimentCheckpoint.digest !==
			createHash("sha256")
				.update(JSON.stringify(experimentPolicy))
				.digest("hex") ||
		!variant ||
		variant.agentId !== boundary.agentId ||
		variant.configurationRevision !== binding.configurationRevision ||
		variant.modelOptionId !== binding.modelOptionId ||
		variant.reasoningLevel !== binding.reasoningLevel ||
		variant.toolEnvironment !== binding.toolEnvironment
	)
		throw new EvaluationDataErrorV1("denied");
	const [checkpoint] = await tx<
		{ revision: string; digest: string }[]
	>`select revision,digest from platform.evaluation_policies where id='active' for share`;
	if (
		!checkpoint ||
		+checkpoint.revision !== policy.revision ||
		checkpoint.digest !==
			createHash("sha256").update(JSON.stringify(policy)).digest("hex")
	)
		throw new EvaluationDataErrorV1("unavailable");
	const [agent] = await tx<
		{ configuration_revision: string }[]
	>`select current_configuration_revision::text as configuration_revision from platform.agents where id=${boundary.agentId} for share`;
	if (!agent || +agent.configuration_revision !== binding.configurationRevision)
		throw new EvaluationDataErrorV1("denied");
	const [row] = await tx<
		{ data: unknown; dataset_id: string; status: string; expires_at: Date }[]
	>`select data,dataset_id,status,expires_at from platform.evaluation_versions where id=${binding.versionId} for share`;
	const [grantRow] = await tx<
		{ data: unknown; dataset_id: string }[]
	>`select data,dataset_id from platform.evaluation_grants where id=${binding.grantId} for share`;
	if (!row || !grantRow) throw new EvaluationDataErrorV1("denied");
	const version = parseEvaluationVersionV1(row.data);
	const grant = parseEvaluationGrantV1(grantRow.data);
	const [clock] = await tx<{ now: Date }[]>`select clock_timestamp() as now`;
	if (
		!clock ||
		version.versionId !== binding.versionId ||
		row.dataset_id !== binding.datasetId ||
		version.datasetId !== binding.datasetId ||
		row.status !== version.status ||
		row.expires_at.toISOString() !== version.expiresAt ||
		version.status !== "available" ||
		grantRow.dataset_id !== binding.datasetId ||
		grant.datasetId !== binding.datasetId ||
		grant.grantId !== binding.grantId ||
		grant.revision !== binding.grantRevision ||
		grant.revoked ||
		!grant.versionIds.includes(binding.versionId) ||
		!grant.operations.includes("run") ||
		!isDeepStrictEqual(grant.principal, boundary.principal) ||
		grant.policyId !== binding.policyId ||
		grant.policyRevision !== binding.policyRevision ||
		policy.policyId !== binding.policyId ||
		policy.revision !== binding.policyRevision ||
		Math.min(
			Date.parse(experimentPolicy.validUntil),
			Date.parse(binding.expiresAt),
			Date.parse(policy.validUntil),
			Date.parse(grant.expiresAt),
			Date.parse(version.expiresAt),
			Date.parse(version.createdAt) + policy.retention.samples.contentMs,
			Date.parse(version.createdAt) + policy.retention.rubric.contentMs,
		) <= +clock.now
	)
		throw new EvaluationDataErrorV1("denied");
	const [sample] = await tx<
		{
			principal: TaskPrincipalV1;
			binding: EvaluationTaskBindingV1;
			status: string;
		}[]
	>`select experiment.principal,sample.binding,experiment.status from platform.evaluation_sample_tasks sample join platform.evaluation_experiments experiment on experiment.id=sample.experiment_id where sample.experiment_id=${binding.experimentId} and sample.sample_id=${binding.sampleId} and sample.variant_id=${binding.variantId} for share of sample,experiment`;
	if (
		!sample ||
		sample.status !== "active" ||
		!isDeepStrictEqual(sample.principal, boundary.principal) ||
		!isDeepStrictEqual(sample.binding, binding)
	)
		throw new EvaluationDataErrorV1("denied");
	return { version, grant, policy };
}
export type EvaluationCurrentPolicyReaderV1 = {
	data: () => Promise<EvaluationPolicyV1>;
	experiment: () => Promise<unknown>;
};

export class PostgresEvaluationTaskAuthorityV1 {
	readonly #client;
	constructor(
		private readonly options: {
			databaseUrl: string;
			loadPolicy: EvaluationCurrentPolicyReaderV1;
			directory?: TaskUserDirectoryV1;
		},
	) {
		this.#client = postgresClient(options.databaseUrl, { max: 3 });
	}
	async close() {
		await this.#client.end();
	}
	async conversationCurrent(
		scope: { actorId: string; channelId: string; principal?: TaskPrincipalV1 },
		conversationId: string,
	) {
		if (scope.channelId !== "eval") return false;
		try {
			return await this.#client.begin(async (tx) => {
				const [row] = await tx<
					{ boundary: unknown }[]
				>`select a.boundary from platform.task_authorization_records a join platform.conversation_executions e on e.execution_id=a.execution_id where e.conversation_id=${conversationId} and e.channel_id='eval' and e.actor_id=${scope.actorId} and e.principal_type=${scope.principal?.kind ?? "user"} and a.revoked_at is null order by e.created_at desc limit 1`;
				if (!row) return false;
				const boundary = parseTaskAuthorizationBoundaryV1(row.boundary);
				await requireCurrentEvaluationTaskV1(
					tx,
					boundary,
					this.options.loadPolicy,
				);
				await requireCurrentEvaluationAdmissionV1(
					tx,
					{
						schemaVersion: 1,
						actorId: boundary.principal.id,
						agentId: boundary.agentId,
						channelId: "eval",
						authorizationRevision: boundary.agentAuthorizationRevision,
						supportsSupplementaryInstruction: false,
						taskBoundary: boundary,
					},
					this.options.directory,
					this.options.loadPolicy,
				);
				return true;
			});
		} catch {
			return false;
		}
	}

	async fileCurrent(
		input: {
			actorId: string;
			agentId: string;
			conversationId: string;
			channelId: string;
			executionId: string;
			sessionGeneration: number;
			evaluation: EvaluationFileBindingV1;
		},
		kind: "attachment" | "result",
	) {
		try {
			return await this.#client.begin(async (tx) => {
				const [row] = await tx<
					{
						boundary: unknown;
						revoked_at: Date | null;
						status: string;
						generation: string;
						fence: string;
						actor_id: string;
						principal_type: string;
						agent_id: string;
						channel_id: string;
						authorization_revision: string;
						stop_pending: boolean;
						management_status: string;
						desired_state: string;
						service_availability: string | null;
						workload_revision: string;
						management_fence: string;
						workload: unknown;
						configuration: unknown;
					}[]
				>`select a.boundary,a.revoked_at,t.status,t.session_generation::text as generation,t.delivery_fence::text as fence,t.actor_id,t.principal_type,t.agent_id,t.channel_id,t.authorization_revision,exists(select 1 from platform.conversation_stops s where s.execution_id=t.execution_id and s.status='submitted') as stop_pending,m.status as management_status,m.desired_state,m.service_availability,m.workload_revision::text,m.fence::text as management_fence,w.state as workload,cr.configuration from platform.task_authorization_records a join platform.conversation_executions t on t.execution_id=a.execution_id join platform.conversations c on c.id=t.conversation_id and c.principal_type=t.principal_type and c.actor_id=t.actor_id and c.agent_id=t.agent_id and c.channel_id=t.channel_id and c.session_generation=t.session_generation join platform.agent_applications m on m.agent_id=t.agent_id join platform.agents ag on ag.id=t.agent_id join platform.agent_configuration_revisions cr on cr.agent_id=ag.id and cr.revision=ag.current_configuration_revision left join platform.workload_reconciliations w on w.agent_id=t.agent_id where a.id=${input.evaluation.authorizationRecordId} and t.execution_id=${input.executionId} and c.id=${input.conversationId}`;
				if (
					!row ||
					row.revoked_at ||
					row.stop_pending ||
					!["submitted", "processing", "unknown"].includes(row.status) ||
					+row.generation !== input.sessionGeneration ||
					+row.fence !== input.evaluation.deliveryFence ||
					row.actor_id !== input.actorId ||
					row.agent_id !== input.agentId ||
					row.channel_id !== "eval" ||
					input.channelId !== "eval" ||
					row.principal_type !== input.evaluation.principal.kind ||
					input.evaluation.principal.id !== input.actorId
				)
					return null;
				const boundary = parseTaskAuthorizationBoundaryV1(row.boundary);
				if (
					!boundary.evaluation ||
					!isDeepStrictEqual(boundary.principal, input.evaluation.principal) ||
					boundary.agentAuthorizationRevision !== row.authorization_revision
				)
					return null;
				const decoded = decodePersistedWorkloadStateV1(
					row.workload,
					input.agentId,
				);
				if (!decoded || decoded.legacy) return null;
				const configuration = decodeVersionedAgentConfigurationRecord(
					row.configuration,
				);
				if (
					!isDeepStrictEqual(
						configuration,
						decoded.state.verified?.configuration,
					)
				)
					return null;
				if (
					!isEvaluationFileRuntimeCurrentV1({
						configurationRevision: boundary.evaluation.configurationRevision,
						workload: decoded.state,
						status: row.management_status,
						desiredState: row.desired_state,
						serviceAvailability: row.service_availability,
						workloadRevision: +row.workload_revision,
						fence: +row.management_fence,
						kind,
					})
				)
					return null;
				await requireCurrentEvaluationAdmissionV1(
					tx,
					{
						schemaVersion: 1,
						actorId: input.actorId,
						agentId: input.agentId,
						channelId: "eval",
						authorizationRevision: boundary.agentAuthorizationRevision,
						supportsSupplementaryInstruction: false,
						taskBoundary: boundary,
					},
					this.options.directory,
					this.options.loadPolicy,
				);
				return {
					configurationRevision: boundary.evaluation.configurationRevision,
				};
			});
		} catch {
			return null;
		}
	}

	async current(boundary: TaskAuthorizationBoundaryV1): Promise<boolean> {
		try {
			return await this.#client.begin(async (tx) => {
				await requireCurrentEvaluationTaskV1(
					tx,
					boundary,
					this.options.loadPolicy,
				);
				return true;
			});
		} catch {
			return false;
		}
	}
}
