import postgres from "postgres";

export type ProviderEgressHopIntent = {
	assertionHash: string;
	callId: string;
	dispatchId: string;
	effect: "READ" | "WRITE";
	effectDispatchId?: string;
	hopId: string;
	jti: string;
};

export class PostgresProviderEgressAdmission {
	private readonly sql;

	constructor(databaseUrl: string) {
		this.sql = postgres(databaseUrl, { max: 10 });
	}

	async close() {
		await this.sql.end();
	}

	async prepare(intent: ProviderEgressHopIntent) {
		const rows = await this.sql<{ hop_id: string }[]>`
			INSERT INTO connection_provider_egress_hops (
				hop_id, call_id, egress_dispatch_id, effect_dispatch_id,
				effect, jti, assertion_hash, state
			)
			SELECT ${intent.hopId}, call.id, ${intent.dispatchId}, dispatch.id, action.effect,
				${intent.jti}, ${intent.assertionHash}, 'PREPARED'
			FROM connection_calls call
			JOIN connection_action_versions action ON action.id = call.action_version_id
			LEFT JOIN connection_effects effect ON effect.call_id = call.id
			LEFT JOIN connection_dispatches dispatch
				ON dispatch.effect_id = effect.id
					AND dispatch.id = ${intent.effectDispatchId ?? null}
			WHERE call.id = ${intent.callId}
				AND action.effect = ${intent.effect}
				AND (
					(action.effect = 'READ' AND ${intent.effectDispatchId ?? null}::text IS NULL)
					OR (
						action.effect = 'WRITE'
						AND dispatch.id = ${intent.effectDispatchId ?? null}
					)
				)
			ON CONFLICT DO NOTHING
			RETURNING hop_id
		`;
		if (rows.length === 1) return;
		const [stored] = await this.sql<ProviderEgressHopIntent[]>`
			SELECT hop_id AS "hopId", call_id AS "callId",
				egress_dispatch_id AS "dispatchId",
				effect_dispatch_id AS "effectDispatchId", effect, jti,
				assertion_hash AS "assertionHash"
			FROM connection_provider_egress_hops
			WHERE hop_id = ${intent.hopId}
		`;
		if (
			!stored ||
			stored.callId !== intent.callId ||
			stored.dispatchId !== intent.dispatchId ||
			(stored.effectDispatchId ?? undefined) !== intent.effectDispatchId ||
			stored.effect !== intent.effect ||
			stored.jti !== intent.jti ||
			stored.assertionHash !== intent.assertionHash
		) {
			throw new Error(
				"Provider Egress hop intent conflicts with durable state",
			);
		}
	}

	async admit(input: {
		assertionHash: string;
		dispatchId: string;
		hopId: string;
		jti: string;
		leaseProofHash: string;
	}): Promise<"ACCEPTED_NOW" | "REJECTED" | "REPLAYED"> {
		return this.sql.begin(async (sql) => {
			const existing = await sql<
				{ assertion_hash: string; hop_id: string; jti: string }[]
			>`
				SELECT hop_id, jti, assertion_hash
				FROM connection_egress_admissions
				WHERE hop_id = ${input.hopId} OR jti = ${input.jti}
			`;
			if (existing.length) {
				return existing.some(
					(row) =>
						row.hop_id === input.hopId &&
						row.jti === input.jti &&
						row.assertion_hash === input.assertionHash,
				)
					? "REPLAYED"
					: "REJECTED";
			}
			const [hop] = await sql<
				{
					assertion_hash: string;
					call_id: string;
					effect_dispatch_id: string | null;
					egress_dispatch_id: string;
					effect: "READ" | "WRITE";
					jti: string;
					state: string;
				}[]
			>`
				SELECT call_id, egress_dispatch_id, effect_dispatch_id,
					effect, jti, assertion_hash, state
				FROM connection_provider_egress_hops
				WHERE hop_id = ${input.hopId}
				FOR UPDATE
			`;
			if (hop?.state === "ADMITTED") {
				const [admission] = await sql<
					{ assertion_hash: string; jti: string }[]
				>`
					SELECT jti, assertion_hash FROM connection_egress_admissions
					WHERE hop_id = ${input.hopId}
				`;
				return admission?.jti === input.jti &&
					admission.assertion_hash === input.assertionHash
					? "REPLAYED"
					: "REJECTED";
			}
			if (
				hop?.state !== "PREPARED" ||
				hop.jti !== input.jti ||
				hop.assertion_hash !== input.assertionHash ||
				hop.egress_dispatch_id !== input.dispatchId
			) {
				return "REJECTED";
			}
			const [call] = await sql<{ effect: string; status: string }[]>`
				SELECT action.effect, call.status
				FROM connection_calls call
				JOIN connection_action_versions action ON action.id = call.action_version_id
				WHERE call.id = ${hop.call_id}
				FOR UPDATE OF call
			`;
			if (!call || call.effect !== hop.effect || call.status !== "AUTHORIZED") {
				return "REJECTED";
			}
			if (hop.effect === "WRITE") {
				const [dispatch] = await sql<{ status: string }[]>`
					SELECT status FROM connection_dispatches
					WHERE id = ${hop.effect_dispatch_id ?? ""}
					FOR UPDATE
				`;
				if (dispatch?.status !== "SUBMISSION_STARTED") return "REJECTED";
			}
			await sql`
				UPDATE connection_provider_egress_hops SET state = 'ADMITTED'
				WHERE hop_id = ${input.hopId} AND state = 'PREPARED'
			`;
			await sql`
				INSERT INTO connection_egress_admissions (
					hop_id, jti, assertion_hash, lease_proof_hash
				) VALUES (
					${input.hopId}, ${input.jti}, ${input.assertionHash},
					${input.leaseProofHash}
				)
			`;
			return "ACCEPTED_NOW";
		});
	}
}
