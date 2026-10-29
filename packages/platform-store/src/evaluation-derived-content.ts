import { createHash, randomUUID } from "node:crypto";
import {
	createEvaluationDataV1,
	EvaluationDataErrorV1,
	type EvaluationDerivedContentPortV1,
	type EvaluationDerivedKindV1,
	type EvaluationDerivedObjectV1,
	type EvaluationPolicyV1,
	type EvaluationRequestV1,
	type EvaluationStorageV1,
	parseEvaluationDerivedObjectV1,
	type TaskUserDirectoryV1,
} from "@agent-infra/platform-core";
import { PostgresEvaluationDataStoreV1 } from "./evaluation-data.js";
import postgres from "./observed-postgres.js";

type ObjectRow = {
	id: string;
	dataset_id: string;
	version_id: string;
	kind: string;
	status: string;
	expires_at: Date;
	metadata_expires_at: Date;
	data: EvaluationDerivedObjectV1;
};
function decodeObject(row: ObjectRow) {
	const value = parseEvaluationDerivedObjectV1(row.data);
	if (
		value.id !== row.id ||
		value.datasetId !== row.dataset_id ||
		value.versionId !== row.version_id ||
		value.kind !== row.kind ||
		value.status !== row.status ||
		value.expiresAt !== row.expires_at.toISOString() ||
		value.metadataExpiresAt !== row.metadata_expires_at.toISOString()
	)
		throw new EvaluationDataErrorV1("unavailable");
	return value;
}
export class PostgresEvaluationDerivedContentV1
	implements EvaluationDerivedContentPortV1
{
	readonly #client;
	readonly #dataStore;
	readonly #data;
	constructor(
		private readonly options: {
			databaseUrl: string;
			directory: TaskUserDirectoryV1;
			loadPolicy: () => Promise<EvaluationPolicyV1>;
			storage: EvaluationStorageV1;
		},
	) {
		this.#client = postgres(options.databaseUrl, { max: 3 });
		this.#dataStore = new PostgresEvaluationDataStoreV1(options);
		this.#data = createEvaluationDataV1({
			store: this.#dataStore,
			storage: options.storage,
			loadPolicy: options.loadPolicy,
		});
	}
	async close() {
		await this.#dataStore.close();
		await this.#client.end();
	}
	async authorize(
		request: EvaluationRequestV1,
		datasetId: string,
		versionId: string,
		kind: EvaluationDerivedKindV1,
	) {
		return request.credentialScope === "eval:analyze"
			? this.#data.authorizeAnalyze(request, datasetId, versionId)
			: kind === "review" || request.credentialScope === "eval:review"
				? this.#data.authorizeReview(request, datasetId, versionId)
				: kind === "score" ||
						request.credentialScope === "eval:score" ||
						request.authentication.kind === "score_work"
					? this.#data.authorizeScore(request, datasetId, versionId)
					: this.#data.authorizeRun(request, datasetId, versionId);
	}
	async #transaction<T>(
		request: EvaluationRequestV1,
		datasetId: string,
		versionId: string,
		kind: EvaluationDerivedKindV1,
		work: (
			tx: postgres.TransactionSql,
			binding: Awaited<
				ReturnType<PostgresEvaluationDerivedContentV1["authorize"]>
			>,
		) => Promise<T>,
	): Promise<T> {
		const result = await this.#client.begin(async (tx) => {
			const store = new PostgresEvaluationDataStoreV1({
				...this.options,
				transaction: tx,
			});
			const data = createEvaluationDataV1({
				store,
				storage: this.options.storage,
				loadPolicy: this.options.loadPolicy,
			});
			const check = () =>
				kind === "review" || request.credentialScope === "eval:review"
					? data.authorizeReview(request, datasetId, versionId)
					: kind === "score" ||
							request.credentialScope === "eval:score" ||
							request.authentication.kind === "score_work"
						? data.authorizeScore(request, datasetId, versionId)
						: data.authorizeRun(request, datasetId, versionId);
			const binding = await check();
			const result = await work(tx, binding);
			await check();
			return { value: result };
		});
		return result.value;
	}
	async reserve(
		request: EvaluationRequestV1,
		key: string,
		value: EvaluationDerivedObjectV1,
	) {
		const binding = await this.authorize(
			request,
			value.datasetId,
			value.versionId,
			value.kind,
		);
		const id = `eval-object:${createHash("sha256")
			.update(
				JSON.stringify([
					binding.principal,
					value.datasetId,
					value.versionId,
					value.kind,
					key,
				]),
			)
			.digest("hex")}`;
		return this.#transaction(
			request,
			value.datasetId,
			value.versionId,
			value.kind,
			async (tx, current) => {
				const [receipt] = await tx<
					{
						result: { objectId: string; expiresAt: string };
						request_digest: string;
					}[]
				>`select result,request_digest from platform.idempotency_records where id=${id} for update`;
				if (receipt) {
					if (
						receipt.request_digest !== value.sha256 ||
						Date.parse(receipt.result.expiresAt) <= Date.now()
					)
						throw new EvaluationDataErrorV1("conflict");
					const [row] = await tx<
						ObjectRow[]
					>`select * from platform.evaluation_derived_objects where id=${receipt.result.objectId} for update`;
					if (row) row.data = decodeObject(row);
					if (
						!row ||
						row.data.datasetId !== value.datasetId ||
						row.data.versionId !== value.versionId ||
						!["pending", "available"].includes(row.data.status)
					)
						throw new EvaluationDataErrorV1("denied");
					const [clock] = await tx<
						{ now: Date }[]
					>`select clock_timestamp() as now`;
					if (!clock) throw new EvaluationDataErrorV1("unavailable");
					const expiry = Math.min(
						Date.parse(row.data.expiresAt),
						Date.parse(row.data.createdAt) +
							current.policy.retention[value.kind].contentMs,
						Date.parse(current.policy.validUntil),
						Date.parse(current.grant.expiresAt),
					);
					if (expiry <= +clock.now) throw new EvaluationDataErrorV1("denied");
					if (row.data.status === "pending") {
						row.data.transferUntil = new Date(
							Math.min(+clock.now + current.policy.transferTimeoutMs, expiry) +
								5000,
						).toISOString();
						await tx`update platform.evaluation_derived_objects set data=${tx.json(row.data as unknown as postgres.JSONValue)} where id=${row.id} and status='pending'`;
					}
					return row.data;
				}
				await tx`insert into platform.evaluation_derived_objects(id,dataset_id,version_id,kind,status,expires_at,metadata_expires_at,data)values(${value.id},${value.datasetId},${value.versionId},${value.kind},${value.status},${value.expiresAt},${value.metadataExpiresAt},${tx.json(value as unknown as postgres.JSONValue)})`;
				await tx`insert into platform.idempotency_records(id,scope_type,scope_id,actor_id,command_type,idempotency_key,request_digest,status,result)values(${id},'evaluation',${JSON.stringify(binding.principal)},${binding.principal.id},'evaluation.derived.write',${createHash("sha256").update(key).digest("hex")},${value.sha256},'completed',${tx.json({ objectId: value.id, expiresAt: value.metadataExpiresAt })})`;
				return value;
			},
		);
	}
	async recover(
		request: EvaluationRequestV1,
		key: string,
		datasetId: string,
		versionId: string,
		kind: EvaluationDerivedKindV1,
	) {
		const authority = await this.authorize(request, datasetId, versionId, kind);
		const id = `eval-object:${createHash("sha256")
			.update(
				JSON.stringify([authority.principal, datasetId, versionId, kind, key]),
			)
			.digest("hex")}`;
		const [receipt] = await this.#client<
			{ result: { objectId: string; expiresAt: string } }[]
		>`select result from platform.idempotency_records where id=${id}`;
		if (!receipt || Date.parse(receipt.result.expiresAt) <= Date.now())
			return null;
		const value = await this.get(receipt.result.objectId);
		if (
			!value ||
			value.datasetId !== datasetId ||
			value.versionId !== versionId ||
			value.kind !== kind ||
			Date.parse(value.expiresAt) <= Date.now()
		)
			return null;
		if (value.status === "available") return value;
		if (value.status !== "pending") return null;
		const stored = await this.options.storage.inspect(value.objectRef);
		if (!stored) return null;
		if (
			stored.sha256 !== value.sha256 ||
			stored.sizeBytes !== value.sizeBytes ||
			stored.mediaType !== "application/json"
		)
			throw new EvaluationDataErrorV1("unavailable");
		return this.confirm(request, value, stored);
	}

	async confirm(
		request: EvaluationRequestV1,
		value: EvaluationDerivedObjectV1,
		stored: NonNullable<EvaluationDerivedObjectV1["stored"]>,
	) {
		return this.#transaction(
			request,
			value.datasetId,
			value.versionId,
			value.kind,
			async (tx, binding) => {
				const [row] = await tx<
					ObjectRow[]
				>`select * from platform.evaluation_derived_objects where id=${value.id} for update`;
				if (row) row.data = decodeObject(row);
				if (
					!row ||
					row.data.status !== "pending" ||
					row.data.sha256 !== stored.sha256 ||
					row.data.sizeBytes !== stored.sizeBytes ||
					stored.mediaType !== "application/json" ||
					Date.parse(row.data.expiresAt) <= Date.now()
				)
					throw new EvaluationDataErrorV1("conflict");
				const result = { ...row.data, status: "available" as const, stored };
				await tx`update platform.evaluation_derived_objects set status='available',data=${tx.json(result as unknown as postgres.JSONValue)} where id=${value.id}`;
				await tx`insert into platform.audit_events(id,trace_id,request_id,actor_type,actor_id,action,target_type,target_id,outcome,details)values(${randomUUID()},${request.traceId},${request.requestId},${binding.principal.kind},${binding.principal.id},'evaluation.derived.confirm','evaluation_object',${value.id},'succeeded',${tx.json({ purpose: "eval", returnedMaterial: false })})`;
				return result;
			},
		);
	}
	async get(id: string) {
		const [row] = await this.#client<
			ObjectRow[]
		>`select * from platform.evaluation_derived_objects where id=${id}`;
		return row ? decodeObject(row) : null;
	}
}
