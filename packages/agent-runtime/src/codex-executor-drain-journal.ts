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
const attemptSchema = z.strictObject({
	protocolSession: identifier,
	handle: identifier,
});
const stopSchema = z.strictObject({
	stopRequestId: identifier,
	stopFence: fence,
	natural: z.literal(true).optional(),
});
const stateSchema = z.strictObject({
	schemaVersion: z.literal(1),
	scope: scopeSchema,
	nativeTurnId: identifier.optional(),
	attempts: z.array(attemptSchema).max(4_096),
	stop: stopSchema.optional(),
	confirmed: z.boolean(),
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
				state.attempts.map(({ protocolSession, handle }) => [
					protocolSession,
					handle,
				]),
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
			(loaded.data.confirmed && !loaded.data.stop)
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
	async admit(input: State["attempts"][number]) {
		const attempt = attemptSchema.parse(input);
		return this.file.update(
			(state) => {
				if (
					!state.nativeTurnId ||
					state.stop ||
					state.attempts.length >= 4_096 ||
					state.attempts.some((existing) =>
						isDeepStrictEqual(existing, attempt),
					)
				)
					return false;
				state.attempts.push(attempt);
				return true;
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
	async confirm(input: NonNullable<State["stop"]>, digest: string) {
		const stop = stopSchema.parse(input);
		return this.file.update(
			(state) => {
				if (
					!isDeepStrictEqual(state.stop, stop) ||
					inventory(state).digest !== digest
				)
					return false;
				state.confirmed = true;
				return true;
			},
			{ skipUnchanged: true },
		);
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
