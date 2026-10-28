import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { snapshotAgentManagementDenseArray } from "./agent-management-input.js";
import type {
	ConversationTaskSubmitCommandV1,
	ConversationTaskSubmitDecisionV1,
} from "./conversation-execution-task.js";
import type { ConversationExecutionAuthorityV1 } from "./conversation-execution-types.js";
import { snapshotObject } from "./conversation-execution-values.js";
import {
	type ConversationOperationFactV2,
	parseConversationOperationEventV2,
} from "./conversation-operation-facts.js";
import {
	type createEvaluationDataV1,
	EvaluationDataErrorV1,
	type EvaluationPrincipalV1,
	type EvaluationRequestV1,
} from "./evaluation-data.js";
import {
	type EvaluationExperimentPolicyV1,
	parseEvaluationExperimentPolicyV1,
} from "./evaluation-experiment-policy.js";
import {
	type EvaluationScoreIntentV1,
	planEvaluationScoreIntentV1,
} from "./evaluation-score-intents.js";
import {
	type EvaluationTaskBindingV1,
	parseEvaluationTaskBindingV1,
} from "./evaluation-task-binding.js";
import {
	type DirectorySnapshotBindingV1,
	parseTaskAuthorizationBoundaryV1,
	parseTaskPrincipalV1,
} from "./task-authorization.js";
export interface EvaluationExperimentV1 {
	readonly experimentId: string;
	readonly datasetId: string;
	readonly versionId: string;
	readonly principal: EvaluationPrincipalV1;
	readonly policyId: string;
	readonly policyRevision: number;
	readonly sampleIds: readonly string[];
	readonly variantIds: readonly string[];
	readonly scorerRefs: readonly { scorerId: string; version: string }[];
	readonly status: "active" | "cancelled";
	readonly revision: number;
	readonly createdAt: string;
	readonly metadataExpiresAt: string;
}
export interface EvaluationSampleTaskV1 {
	readonly sampleTaskId: string;
	readonly scoreIds?: readonly string[];
	readonly preparedRuntime?: {
		configurationRevision: number;
		imageDigest: string;
		resourceConfigurationHash: string;
	};
	readonly actual?: {
		status: string;
		billing: {
			purpose: "agent-default";
			subjectId: string;
			keyVersion: number;
		} | null;
		lastSequence: number;
		runtimeObserved: boolean;
		preparedRuntime: EvaluationSampleTaskV1["preparedRuntime"] | null;
		facts: ReturnType<typeof projectEvaluationExecutionFactsV1>;
		factsTruncated: boolean;
	};
	readonly experimentId: string;
	readonly sampleId: string;
	readonly variantId: string;
	readonly conversationId: string;
	readonly executionId: string;
	readonly binding: EvaluationTaskBindingV1;
	readonly requested: EvaluationExperimentPolicyV1["variants"][number];
}
export interface EvaluationExperimentCreateV1 {
	readonly datasetId: string;
	readonly versionId: string;
	readonly variantIds: readonly string[];
	readonly scorerRefs: readonly { scorerId: string; version: string }[];
}
const invalid = (): never => {
	throw new EvaluationDataErrorV1("invalid");
};
function text(v: unknown) {
	if (typeof v !== "string" || !v || v.length > 256 || !v.isWellFormed())
		return invalid();
	return v;
}
export function parseEvaluationExperimentCreateV1(
	input: unknown,
): EvaluationExperimentCreateV1 {
	const x = snapshotObject(input, [
		"datasetId",
		"versionId",
		"variantIds",
		"scorerRefs",
	]);
	const variantIds = snapshotAgentManagementDenseArray(x.variantIds, 100).map(
		text,
	);
	const scorerRefs = snapshotAgentManagementDenseArray(x.scorerRefs, 100).map(
		(input) => {
			const r = snapshotObject(input, ["scorerId", "version"]);
			return { scorerId: text(r.scorerId), version: text(r.version) };
		},
	);
	if (
		variantIds.length < 2 ||
		!scorerRefs.length ||
		new Set(variantIds).size !== variantIds.length ||
		new Set(scorerRefs.map((s) => JSON.stringify([s.scorerId, s.version])))
			.size !== scorerRefs.length
	)
		return invalid();
	return {
		datasetId: text(x.datasetId),
		versionId: text(x.versionId),
		variantIds,
		scorerRefs,
	};
}
export function requireEvaluationExperimentSelectionV1(
	command: EvaluationExperimentCreateV1,
	policy: EvaluationExperimentPolicyV1,
	sampleIds: readonly string[],
) {
	if (sampleIds.length * command.variantIds.length > policy.maximumTasks)
		throw new EvaluationDataErrorV1("denied");
	const variants = command.variantIds.map(
		(id) => policy.variants.find((v) => v.variantId === id) ?? invalid(),
	);
	const scorers = command.scorerRefs.map(
		(ref) =>
			policy.scorers.find(
				(s) => s.scorerId === ref.scorerId && s.version === ref.version,
			) ?? invalid(),
	);
	return { variants, scorers };
}

export type EvaluationRunSourceV1 = Awaited<
	ReturnType<ReturnType<typeof createEvaluationDataV1>["readForRun"]>
>;
export interface EvaluationExperimentTransactionV1 {
	now: Date;
	currentTime(): Promise<Date>;
	authorizeRun(): Promise<Omit<EvaluationRunSourceV1, "content">>;
	currentPolicy(): Promise<EvaluationExperimentPolicyV1>;
	bindPolicy(policy: EvaluationExperimentPolicyV1): Promise<void>;
	receipt(scope: string): Promise<{
		digest: string;
		experimentId: string;
		expiresAt: string;
	} | null>;
	experiment(id: string): Promise<EvaluationExperimentV1 | null>;
	saveExperiment(value: EvaluationExperimentV1): Promise<void>;
	lockAgents(ids: readonly string[]): Promise<void>;
	agentAuthority(agentId: string): Promise<{
		identityRevision: string;
		agentRevision: string;
		configurationRevision: number;
		useGrantRevision: string;
		directorySnapshotBinding?: DirectorySnapshotBindingV1;
	} | null>;
	reserveSample(id: string, binding: EvaluationTaskBindingV1): Promise<void>;
	submitTask(
		authority: ConversationExecutionAuthorityV1,
		command: ConversationTaskSubmitCommandV1,
	): Promise<ConversationTaskSubmitDecisionV1>;
	saveSample(value: EvaluationSampleTaskV1): Promise<void>;
	reserveScores(intents: readonly EvaluationScoreIntentV1[]): Promise<void>;
	saveReceipt(
		scope: string,
		value: { digest: string; experimentId: string; expiresAt: string },
	): Promise<void>;
	audit(action: string, targetId: string): Promise<void>;
}
export interface EvaluationExperimentTransactionPortV1 {
	authorizeAgents(
		request: EvaluationRequestV1,
		experiment: EvaluationExperimentV1,
	): Promise<void>;
	policyCheckpoint(): Promise<{
		revision: number;
		digest: string;
		now: Date;
	} | null>;
	target(id: string): Promise<EvaluationExperimentV1 | null>;
	samples(
		id: string,
		limit: number,
		cursor?: string,
	): Promise<EvaluationSampleTaskV1[]>;
	cancel(
		request: EvaluationRequestV1,
		id: string,
		key: string,
	): Promise<EvaluationExperimentV1>;
	transaction<T>(
		request: EvaluationRequestV1,
		command: EvaluationExperimentCreateV1,
		work: (tx: EvaluationExperimentTransactionV1) => Promise<T>,
	): Promise<T>;
}
export function createEvaluationExperimentsV1(options: {
	data: ReturnType<typeof createEvaluationDataV1>;
	loadPolicy: () => Promise<unknown>;
	transaction: EvaluationExperimentTransactionPortV1;
}) {
	return {
		async get(
			request: EvaluationRequestV1,
			id: string,
			limit = 50,
			cursor?: string,
		) {
			if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
				return invalid();
			const experiment = await options.transaction.target(id);
			if (!experiment) throw new EvaluationDataErrorV1("denied");
			const checkPolicy = async () => {
				const policy = await options
					.loadPolicy()
					.then(parseEvaluationExperimentPolicyV1)
					.catch(() => {
						throw new EvaluationDataErrorV1("unavailable");
					});
				const checkpoint = await options.transaction.policyCheckpoint();
				if (
					!checkpoint ||
					policy.policyId !== experiment.policyId ||
					policy.revision !== experiment.policyRevision ||
					checkpoint.revision !== policy.revision ||
					checkpoint.digest !==
						createHash("sha256").update(JSON.stringify(policy)).digest("hex") ||
					Date.parse(policy.validUntil) <= +checkpoint.now ||
					Date.parse(experiment.metadataExpiresAt) <= +checkpoint.now ||
					experiment.variantIds.some(
						(id) => !policy.variants.some((v) => v.variantId === id),
					) ||
					experiment.scorerRefs.some(
						(ref) =>
							!policy.scorers.some(
								(s) => s.scorerId === ref.scorerId && s.version === ref.version,
							),
					)
				)
					throw new EvaluationDataErrorV1("denied");
			};
			await checkPolicy();
			const authority = await options.data.authorizeRun(
				request,
				experiment.datasetId,
				experiment.versionId,
			);
			if (!isDeepStrictEqual(authority.principal, experiment.principal))
				throw new EvaluationDataErrorV1("denied");
			await options.transaction.authorizeAgents(request, experiment);
			const tasks = await options.transaction.samples(id, limit + 1, cursor);
			await options.data.authorizeRun(
				request,
				experiment.datasetId,
				experiment.versionId,
			);
			await options.transaction.authorizeAgents(request, experiment);
			await checkPolicy();
			return {
				experiment,
				items: tasks.slice(0, limit).map((task) => ({
					sampleTaskId: task.sampleTaskId,
					sampleId: task.sampleId,
					variantId: task.variantId,
					conversationId: task.conversationId,
					executionId: task.executionId,
					scoreIds: task.scoreIds ?? [],
					requested: task.requested,
					actual: task.actual ?? null,
				})),
				nextCursor:
					tasks.length > limit
						? (tasks[limit - 1]?.sampleTaskId ?? null)
						: null,
			};
		},
		cancel: (request: EvaluationRequestV1, id: string, key: string) =>
			options.transaction.cancel(request, id, key),
		async create(request: EvaluationRequestV1, key: string, input: unknown) {
			const command = parseEvaluationExperimentCreateV1(input);
			if (!/^[A-Za-z0-9._~-]{1,128}$/.test(key)) return invalid();
			const source = await options.data.readForRun(
				request,
				command.datasetId,
				command.versionId,
			);
			const policy = parseEvaluationExperimentPolicyV1(
				await options.loadPolicy(),
			);
			if (
				policy.policyId !== source.policy.policyId ||
				policy.revision !== source.policy.revision
			)
				throw new EvaluationDataErrorV1("unavailable");
			const { variants, scorers } = requireEvaluationExperimentSelectionV1(
				command,
				policy,
				source.content.samples.map((s) => s.id),
			);
			if (
				scorers.some(
					(scorer) =>
						!source.content.rubric.some(
							(rubric) => rubric.id === scorer.rubricId,
						),
				)
			)
				return invalid();
			if (
				scorers.some((scorer) => !scorer.datasetScopes.includes(source.scope))
			)
				throw new EvaluationDataErrorV1("denied");
			const digest = createHash("sha256")
				.update(JSON.stringify(command))
				.digest("hex");
			const scope = JSON.stringify([
				source.principal,
				"evaluation.experiment.create",
				key,
			]);
			return options.transaction.transaction(request, command, async (tx) => {
				const check = async () => {
					const current = await tx.authorizeRun();
					if (
						!isDeepStrictEqual(current, {
							version: source.version,
							grant: source.grant,
							policy: source.policy,
							principal: source.principal,
							scope: source.scope,
						}) ||
						!isDeepStrictEqual(policy, await tx.currentPolicy()) ||
						Date.parse(policy.validUntil) <= +(await tx.currentTime())
					)
						throw new EvaluationDataErrorV1("denied");
				};
				await check();
				await tx.bindPolicy(policy);
				if (Date.parse(policy.validUntil) <= +tx.now)
					throw new EvaluationDataErrorV1("denied");
				const receipt = await tx.receipt(scope);
				if (receipt) {
					if (
						receipt.digest !== digest ||
						Date.parse(receipt.expiresAt) <= +tx.now
					)
						throw new EvaluationDataErrorV1("conflict");
					const original = await tx.experiment(receipt.experimentId);
					if (
						!original ||
						!isDeepStrictEqual(original.principal, source.principal)
					)
						throw new EvaluationDataErrorV1("denied");
					return original;
				}
				const experiment: EvaluationExperimentV1 = {
					experimentId: randomUUID(),
					datasetId: command.datasetId,
					versionId: command.versionId,
					principal: source.principal,
					policyId: policy.policyId,
					policyRevision: policy.revision,
					sampleIds: source.content.samples.map((s) => s.id),
					variantIds: command.variantIds,
					scorerRefs: command.scorerRefs,
					status: "active",
					revision: 1,
					createdAt: tx.now.toISOString(),
					metadataExpiresAt: source.version.metadataExpiresAt,
				};
				await tx.saveExperiment(experiment);
				await tx.lockAgents(
					[...new Set(variants.map((v) => v.agentId))].sort(),
				);
				for (const sample of source.content.samples)
					for (const variant of variants) {
						const agent = await tx.agentAuthority(variant.agentId);
						if (
							!agent ||
							agent.configurationRevision !== variant.configurationRevision
						)
							throw new EvaluationDataErrorV1("denied");
						const binding: EvaluationTaskBindingV1 = {
							schemaVersion: 1,
							experimentId: experiment.experimentId,
							sampleId: sample.id,
							variantId: variant.variantId,
							datasetId: command.datasetId,
							versionId: command.versionId,
							grantId: source.grant.grantId,
							grantRevision: source.grant.revision,
							policyId: source.policy.policyId,
							policyRevision: source.policy.revision,
							configurationRevision: variant.configurationRevision,
							modelOptionId: variant.modelOptionId,
							reasoningLevel: variant.reasoningLevel,
							toolEnvironment: variant.toolEnvironment,
							expiresAt: new Date(
								Math.min(
									Date.parse(source.grant.expiresAt),
									Date.parse(source.version.expiresAt),
									Date.parse(source.policy.validUntil),
									Date.parse(policy.validUntil),
								),
							).toISOString(),
						};
						const boundary = parseTaskAuthorizationBoundaryV1({
							schemaVersion: 1,
							principal: source.principal,
							agentId: variant.agentId,
							channelId: "eval",
							identityRevision: agent.identityRevision,
							agentAuthorizationRevision: agent.agentRevision,
							accessSources: [
								{ kind: "eval-use", useGrantRevision: agent.useGrantRevision },
							],
							evaluation: binding,
							...(agent.directorySnapshotBinding
								? { directorySnapshotBinding: agent.directorySnapshotBinding }
								: {}),
						});
						const authority: ConversationExecutionAuthorityV1 = {
							schemaVersion: 1,
							actorId: source.principal.id,
							agentId: variant.agentId,
							channelId: "eval",
							authorizationRevision: agent.agentRevision,
							supportsSupplementaryInstruction: false,
							taskBoundary: boundary,
						};
						const sampleTaskId = randomUUID();
						await tx.reserveSample(sampleTaskId, binding);
						const prompt =
							sample.context === null
								? sample.input
								: `${sample.context}\n\n${sample.input}`;
						if (Buffer.byteLength(prompt) > policy.maximumInputBytes)
							return invalid();
						const accepted = await tx.submitTask(authority, {
							schemaVersion: 1,
							agentId: variant.agentId,
							text: prompt,
							idempotencyKey: `eval.${sampleTaskId}`,
							requestId: request.requestId,
							traceId: request.traceId,
						});
						if (accepted.outcome !== "accepted")
							throw new EvaluationDataErrorV1(
								accepted.outcome === "capacity_full" ? "conflict" : "denied",
							);
						const task: EvaluationSampleTaskV1 = {
							sampleTaskId,
							experimentId: experiment.experimentId,
							sampleId: sample.id,
							variantId: variant.variantId,
							conversationId: accepted.result.conversationId,
							executionId: accepted.result.executionId,
							binding,
							requested: variant,
						};
						await tx.saveSample(task);
						await tx.reserveScores(
							scorers.map((scorer) =>
								planEvaluationScoreIntentV1(task, experiment, scorer),
							),
						);
					}
				await check();
				await tx.saveReceipt(scope, {
					digest,
					experimentId: experiment.experimentId,
					expiresAt: experiment.metadataExpiresAt,
				});
				await tx.audit("evaluation.experiment.create", experiment.experimentId);
				return experiment;
			});
		},
	};
}

export function parseEvaluationExperimentV1(
	input: unknown,
): EvaluationExperimentV1 {
	const value = snapshotObject(input, [
		"experimentId",
		"datasetId",
		"versionId",
		"principal",
		"policyId",
		"policyRevision",
		"sampleIds",
		"variantIds",
		"scorerRefs",
		"status",
		"revision",
		"createdAt",
		"metadataExpiresAt",
	]);
	const principalValue = parseTaskPrincipalV1(value.principal);
	const command = parseEvaluationExperimentCreateV1({
		datasetId: value.datasetId,
		versionId: value.versionId,
		variantIds: value.variantIds,
		scorerRefs: value.scorerRefs,
	});
	const sampleIds = snapshotAgentManagementDenseArray(
		value.sampleIds,
		1000,
	).map(text);
	if (
		!sampleIds.length ||
		new Set(sampleIds).size !== sampleIds.length ||
		(value.status !== "active" && value.status !== "cancelled") ||
		typeof value.revision !== "number" ||
		!Number.isSafeInteger(value.revision) ||
		value.revision < 1 ||
		typeof value.policyRevision !== "number" ||
		!Number.isSafeInteger(value.policyRevision) ||
		value.policyRevision < 1
	)
		return invalid();
	for (const field of ["createdAt", "metadataExpiresAt"]) {
		const date = value[field];
		if (
			typeof date !== "string" ||
			!Number.isFinite(Date.parse(date)) ||
			new Date(date).toISOString() !== date
		)
			return invalid();
	}
	return {
		experimentId: text(value.experimentId),
		...command,
		principal: principalValue,
		policyId: text(value.policyId),
		policyRevision: value.policyRevision,
		sampleIds,
		status: value.status,
		revision: value.revision,
		createdAt: String(value.createdAt),
		metadataExpiresAt: String(value.metadataExpiresAt),
	};
}
export function requireEvaluationExperimentOwnerV1(
	experiment: EvaluationExperimentV1,
	principal: EvaluationPrincipalV1,
) {
	if (!isDeepStrictEqual(experiment.principal, principal))
		throw new EvaluationDataErrorV1("denied");
}

/** Actual model/tool metadata is projected only from persisted runtime operation facts. */
export function projectEvaluationExecutionFactsV1(
	events: readonly { sequence: number; eventType: string; payload: unknown }[],
) {
	const models: {
		operationRef: string;
		attemptRef: string;
		sequence: number;
		phase: string;
		observed: boolean;
		model: Extract<ConversationOperationFactV2, { kind: "model" }>["model"];
		usage:
			| Extract<ConversationOperationFactV2, { kind: "model" }>["usage"]
			| null;
		durationMs: number | null;
	}[] = [];
	const tools: {
		operationRef: string;
		attemptRef: string;
		sequence: number;
		toolId: string;
		phase: string;
		durationMs: number | null;
	}[] = [];
	for (const event of events) {
		if (event.eventType !== "execution.operation") continue;
		const fact = parseConversationOperationEventV2(event.payload).fact;
		if (fact.kind === "model")
			models.push({
				operationRef: fact.operationRef,
				attemptRef: fact.attemptRef,
				sequence: event.sequence,
				observed: fact.phase === "started" || fact.startedAt !== undefined,
				model: fact.model,
				phase: fact.phase,
				usage: fact.usage ?? null,
				durationMs: fact.durationMs ?? null,
			});
		if (fact.kind === "tool")
			tools.push({
				operationRef: fact.operationRef,
				attemptRef: fact.attemptRef,
				sequence: event.sequence,
				toolId: fact.toolId,
				phase: fact.phase,
				durationMs: fact.durationMs ?? null,
			});
	}
	return {
		models,
		tools,
		actualModelObserved: models.some((model) => model.observed),
	};
}

export function parseEvaluationSampleTaskV1(
	input: unknown,
): EvaluationSampleTaskV1 {
	const x = snapshotObject(
		input,
		[
			"sampleTaskId",
			"experimentId",
			"sampleId",
			"variantId",
			"conversationId",
			"executionId",
			"binding",
			"requested",
		],
		["preparedRuntime"],
	);
	const binding = parseEvaluationTaskBindingV1(x.binding);
	const r = snapshotObject(x.requested, [
		"variantId",
		"agentId",
		"configurationRevision",
		"modelOptionId",
		"reasoningLevel",
		"toolEnvironment",
	]);
	if (
		r.variantId !== binding.variantId ||
		r.configurationRevision !== binding.configurationRevision ||
		r.modelOptionId !== binding.modelOptionId ||
		r.reasoningLevel !== binding.reasoningLevel ||
		r.toolEnvironment !== binding.toolEnvironment ||
		x.experimentId !== binding.experimentId ||
		x.sampleId !== binding.sampleId ||
		x.variantId !== binding.variantId
	)
		throw new EvaluationDataErrorV1("unavailable");
	let preparedRuntime: EvaluationSampleTaskV1["preparedRuntime"];
	if (x.preparedRuntime !== undefined) {
		const p = snapshotObject(x.preparedRuntime, [
			"configurationRevision",
			"imageDigest",
			"resourceConfigurationHash",
		]);
		if (
			p.configurationRevision !== binding.configurationRevision ||
			typeof p.imageDigest !== "string" ||
			!/^(?:[^@\s]+@)?sha256:[a-f0-9]{64}$/.test(p.imageDigest) ||
			typeof p.resourceConfigurationHash !== "string" ||
			!/^[a-f0-9]{64}$/.test(p.resourceConfigurationHash)
		)
			throw new EvaluationDataErrorV1("unavailable");
		preparedRuntime = {
			configurationRevision: binding.configurationRevision,
			imageDigest: p.imageDigest,
			resourceConfigurationHash: p.resourceConfigurationHash,
		};
	}
	return {
		sampleTaskId: text(x.sampleTaskId),
		experimentId: text(x.experimentId),
		sampleId: text(x.sampleId),
		variantId: text(x.variantId),
		conversationId: text(x.conversationId),
		executionId: text(x.executionId),
		binding,
		requested: {
			variantId: binding.variantId,
			agentId: text(r.agentId),
			configurationRevision: binding.configurationRevision,
			modelOptionId: binding.modelOptionId,
			reasoningLevel: binding.reasoningLevel,
			toolEnvironment: binding.toolEnvironment,
		},
		...(preparedRuntime ? { preparedRuntime } : {}),
	};
}
