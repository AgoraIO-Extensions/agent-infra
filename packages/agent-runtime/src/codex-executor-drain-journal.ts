import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { DurableJsonFile } from "./durable-json.js";

const identifier = z.string().min(1).max(256);
const fence = z.number().int().positive().safe();
const scopeSchema = z.strictObject({
	executionId: identifier,
	podUid: identifier,
	generation: fence,
	resourceFence: fence,
	epoch: identifier,
});
const rejectionSchema = z.strictObject({
	id: z.string().regex(/^[a-f0-9]{64}$/),
	code: z.number().int().safe(),
	occurredAt: fence,
});
const attemptSchema = z.strictObject({
	protocolSession: identifier,
	handle: identifier,
	rejection: rejectionSchema.optional(),
});
const stopSchema = z.strictObject({
	stopRequestId: identifier,
	stopFence: fence,
	natural: z.literal(true).optional(),
});
const drainEvidenceSchema = z.strictObject({
	verifiedAt: fence,
	rejectedStarts: z
		.array(
			z.strictObject({
				id: z.string().regex(/^[a-f0-9]{64}$/),
				rejectedAt: fence,
			}),
		)
		.max(4_096)
		.optional(),
	groups: z
		.array(
			z.strictObject({
				id: z.string().regex(/^[a-f0-9]{64}$/),
				exitedAt: fence,
			}),
		)
		.max(4_096),
});
export type CodexExecutorDrainEvidenceV1 = z.infer<typeof drainEvidenceSchema>;
const stateSchema = z.strictObject({
	schemaVersion: z.literal(1),
	scope: scopeSchema,
	nativeTurnId: identifier.optional(),
	attempts: z.array(attemptSchema).max(4_096),
	stop: stopSchema.optional(),
	confirmed: z.boolean(),
	evidence: drainEvidenceSchema.optional(),
});
type State = z.infer<typeof stateSchema>;

function invalid(): never {
	throw new Error("CODEX_EXECUTOR_DRAIN_JOURNAL_INVALID");
}

function inventory(state: State) {
	if (!state.stop) return invalid();
	const { executionId, podUid, generation, resourceFence, epoch } = state.scope;
	const digest = createHash("sha256")
		.update(
			JSON.stringify([
				"agent-infra/codex-executor-drain/v1",
				executionId,
				podUid,
				generation,
				resourceFence,
				epoch,
				state.nativeTurnId ?? null,
				state.stop.stopRequestId,
				state.stop.stopFence,
				state.attempts.map(({ protocolSession, handle, rejection }) =>
					rejection
						? [protocolSession, handle, rejection]
						: [protocolSession, handle],
				),
			]),
		)
		.digest("hex");
	return { attempts: structuredClone(state.attempts), digest };
}

/** The persistent file belongs to the trusted Host; tools never mount it. */
export class CodexExecutorDrainJournalV1 {
	private constructor(private readonly file: DurableJsonFile<State>) {}

	static async open(path: string, scope: State["scope"]) {
		const expected = scopeSchema.parse(scope);
		const file = await DurableJsonFile.open<State>(path, {
			schemaVersion: 1,
			scope: expected,
			attempts: [],
			confirmed: false,
		});
		const loaded = stateSchema.safeParse(file.snapshot());
		if (
			!loaded.success ||
			!isDeepStrictEqual(loaded.data.scope, expected) ||
			(loaded.data.confirmed && !loaded.data.stop) ||
			(loaded.data.evidence !== undefined && !loaded.data.confirmed)
		) {
			await file.close();
			return invalid();
		}
		return new CodexExecutorDrainJournalV1(file);
	}

	async bindNativeTurn(input: string) {
		const nativeTurnId = identifier.parse(input);
		await this.file.update(
			(state) => {
				if (state.nativeTurnId && state.nativeTurnId !== nativeTurnId)
					return invalid();
				if (state.stop && !state.nativeTurnId) return invalid();
				state.nativeTurnId = nativeTurnId;
			},
			{ skipUnchanged: true },
		);
	}

	/** A true result is durable before the gateway forwards process/start. */
	async admit(input: { protocolSession: string; handle: string }) {
		const attempt = attemptSchema.omit({ rejection: true }).parse(input);
		return this.file.update(
			(state) => {
				if (
					!state.nativeTurnId ||
					state.stop ||
					state.attempts.length >= 4_096 ||
					state.attempts.some(
						(existing) =>
							existing.protocolSession === attempt.protocolSession &&
							existing.handle === attempt.handle,
					)
				)
					return false;
				state.attempts.push(attempt);
				return true;
			},
			{ skipUnchanged: true },
		);
	}

	/** Only a verified runner response can refine an existing admission; never erase it. */
	async rejectStart(
		input: { protocolSession: string; handle: string },
		code: number,
		occurredAt: number,
	) {
		const attempt = attemptSchema.omit({ rejection: true }).parse(input);
		const value = rejectionSchema
			.omit({ id: true })
			.parse({ code, occurredAt });
		return this.file.update(
			(state) => {
				const existing = state.attempts.find(
					(entry) =>
						entry.protocolSession === attempt.protocolSession &&
						entry.handle === attempt.handle,
				);
				if (!existing || state.confirmed) return invalid();
				if (existing.rejection) {
					if (
						existing.rejection.code !== code ||
						existing.rejection.occurredAt !== occurredAt
					)
						return invalid();
					return structuredClone(existing.rejection);
				}
				const id = createHash("sha256")
					.update(
						JSON.stringify([
							"agent-infra/codex-executor-start-rejected/v1",
							state.scope,
							attempt,
							value,
						]),
					)
					.digest("hex");
				existing.rejection = { id, ...value };
				return structuredClone(existing.rejection);
			},
			{ skipUnchanged: true },
		);
	}

	async seal(input: NonNullable<State["stop"]>) {
		const stop = stopSchema.parse(input);
		return this.file.update(
			(state) => {
				if (state.stop && !isDeepStrictEqual(state.stop, stop)) {
					const renewOriginalStop =
						state.stop.stopRequestId === stop.stopRequestId &&
						!state.stop.natural &&
						!stop.natural &&
						stop.stopFence > state.stop.stopFence;
					const replaceUnconfirmedNaturalCheck =
						state.stop.natural && !stop.natural;
					if (
						state.confirmed ||
						!(renewOriginalStop || replaceUnconfirmedNaturalCheck)
					)
						return invalid();
				}
				state.stop = stop;
				return inventory(state);
			},
			{ skipUnchanged: true },
		);
	}

	/** Call only with the inventory digest from a verified runner proof. */
	async confirm(
		input: NonNullable<State["stop"]>,
		digest: string,
		inputEvidence?: CodexExecutorDrainEvidenceV1,
	) {
		const stop = stopSchema.parse(input);
		const evidence =
			inputEvidence === undefined
				? undefined
				: drainEvidenceSchema.parse(inputEvidence);
		return this.file.update(
			(state) => {
				if (
					!isDeepStrictEqual(state.stop, stop) ||
					inventory(state).digest !== digest
				)
					return false;
				if (!evidence && state.attempts.some((attempt) => attempt.rejection))
					return false;
				if (
					evidence &&
					(evidence.groups.length !==
						state.attempts.filter((attempt) => !attempt.rejection).length ||
						!isDeepStrictEqual(
							evidence.rejectedStarts ?? [],
							state.attempts.flatMap(({ rejection }) =>
								rejection
									? [{ id: rejection.id, rejectedAt: rejection.occurredAt }]
									: [],
							),
						) ||
						(evidence.rejectedStarts ?? []).some(
							({ rejectedAt }) => rejectedAt > evidence.verifiedAt,
						) ||
						new Set(
							[...evidence.groups, ...(evidence.rejectedStarts ?? [])].map(
								({ id }) => id,
							),
						).size !==
							evidence.groups.length + (evidence.rejectedStarts?.length ?? 0) ||
						evidence.groups.some(
							({ exitedAt }) => exitedAt > evidence.verifiedAt,
						))
				)
					return false;
				state.evidence ??= evidence;
				state.confirmed = true;
				return true;
			},
			{ skipUnchanged: true },
		);
	}

	evidence() {
		const state = this.file.snapshot();
		if (!state.confirmed || !state.stop || !state.evidence) return null;
		return {
			...state.scope,
			...state.stop,
			digest: inventory(state).digest,
			...state.evidence,
		};
	}

	confirmed() {
		return this.file.snapshot().confirmed;
	}

	sealedStop() {
		return this.file.snapshot().stop;
	}

	close() {
		return this.file.close();
	}
}
