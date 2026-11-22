import {
	type RuntimePersistedSafetyEvidenceV1,
	RuntimePersistedSafetyEvidenceV1Schema,
	type RuntimeSafetyEvidenceLogEntryV1,
	type RuntimeSafetyEvidenceWindowV1,
} from "@agent-infra/contracts/runtime";
import { DurableJsonFile } from "./durable-json.js";
import { RuntimeHostError } from "./errors.js";

/**
 * Engineering Spec §18.5.1 载体与版本 and Runtime HLD §8.5.6: the Host's safety evidence log.
 * It is a separate durable file with its own cursor and ACK, never the business journal, so a
 * full, failed or unreadable log only leaves evidence UNPROVEN and never touches business events,
 * terminals or their ACK. Records are fixed results; nothing here logs or echoes their content.
 */
interface LogState {
	readonly schemaVersion: 1;
	/** Sequence of the newest durably confirmed entry; entries at or below it are dropped. */
	acknowledged: number;
	nextSequence: number;
	entries: { sequence: number; record: RuntimePersistedSafetyEvidenceV1 }[];
}

export type RuntimeSafetyEvidenceAppendOutcomeV1 =
	| "appended"
	/** Backpressure: the bounded log is full until the Worker confirms older entries. */
	| "full"
	/** Not a record this Host may hand over (unknown kind or shape). */
	| "invalid"
	/** The log could not be written; it stays unavailable until the Host restarts. */
	| "unavailable";

const cursorPrefix = "se1-";
export const runtimeSafetyEvidenceLogCapacityV1 = 256;

function cursorOf(sequence: number) {
	return `${cursorPrefix}${sequence}`;
}

function sequenceOf(cursor: string): number | undefined {
	if (!cursor.startsWith(cursorPrefix)) return undefined;
	const digits = cursor.slice(cursorPrefix.length);
	if (!/^(?:0|[1-9][0-9]{0,15})$/.test(digits)) return undefined;
	const sequence = Number(digits);
	return Number.isSafeInteger(sequence) ? sequence : undefined;
}

function unavailable(): never {
	throw new RuntimeHostError(
		"RUNTIME_SAFETY_EVIDENCE_UNAVAILABLE",
		"Runtime safety evidence is unavailable",
		503,
		true,
	);
}

export class RuntimeSafetyEvidenceLogV1 {
	private constructor(
		private readonly file: DurableJsonFile<LogState>,
		private readonly capacity: number,
	) {}

	static async open(input: {
		readonly path: string;
		readonly capacity?: number;
	}): Promise<RuntimeSafetyEvidenceLogV1> {
		const capacity = input.capacity ?? runtimeSafetyEvidenceLogCapacityV1;
		if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4_096)
			throw new TypeError("Runtime safety evidence log capacity is invalid");
		const file = await DurableJsonFile.open<LogState>(input.path, {
			schemaVersion: 1,
			acknowledged: 0,
			nextSequence: 1,
			entries: [],
		});
		const state = file.read();
		if (
			state.schemaVersion !== 1 ||
			!Number.isSafeInteger(state.acknowledged) ||
			!Number.isSafeInteger(state.nextSequence) ||
			state.acknowledged < 0 ||
			state.nextSequence <= state.acknowledged ||
			!Array.isArray(state.entries) ||
			state.entries.some(
				(entry, index) =>
					!Number.isSafeInteger(entry.sequence) ||
					entry.sequence <= state.acknowledged ||
					entry.sequence >= state.nextSequence ||
					(index > 0 &&
						entry.sequence <= (state.entries[index - 1]?.sequence ?? 0)),
			)
		) {
			await file.close();
			throw new Error("RUNTIME_SAFETY_EVIDENCE_LOG_INVALID");
		}
		return new RuntimeSafetyEvidenceLogV1(file, capacity);
	}

	/**
	 * Durably commits one immutable record. It never throws and never waits on the Worker:
	 * producers keep the business path whatever the outcome (UNPROVEN on anything but appended).
	 */
	async append(record: unknown): Promise<RuntimeSafetyEvidenceAppendOutcomeV1> {
		const parsed = RuntimePersistedSafetyEvidenceV1Schema.safeParse(record);
		if (!parsed.success) return "invalid";
		try {
			return await this.file.update(
				(draft) => {
					if (draft.entries.length >= this.capacity) return "full" as const;
					draft.entries.push({
						sequence: draft.nextSequence,
						record: parsed.data,
					});
					draft.nextSequence++;
					return "appended" as const;
				},
				{ skipUnchanged: true },
			);
		} catch {
			return "unavailable";
		}
	}

	/** Only committed entries after the confirmed cursor; a read never changes the log. */
	async read(input: {
		readonly after: string | null;
		readonly limit: number;
	}): Promise<RuntimeSafetyEvidenceLogEntryV1[]> {
		let state: LogState;
		try {
			state = await this.file.readCommitted();
		} catch {
			unavailable();
		}
		let after = state.acknowledged;
		if (input.after !== null) {
			const requested = sequenceOf(input.after);
			if (requested === undefined || requested >= state.nextSequence)
				throw new RuntimeHostError(
					"RUNTIME_SAFETY_EVIDENCE_CURSOR_INVALID",
					"Runtime safety evidence cursor is invalid",
					409,
				);
			after = Math.max(after, requested);
		}
		return state.entries
			.filter((entry) => entry.sequence > after)
			.slice(0, input.limit)
			.map((entry) => ({
				cursor: cursorOf(entry.sequence),
				record: entry.record,
			}));
	}

	/**
	 * Advances the confirmed cursor to an entry this log has durably committed. Repeating an
	 * older confirmation returns the current cursor; an unknown or future cursor is refused.
	 */
	async acknowledge(cursor: string): Promise<string> {
		const sequence = sequenceOf(cursor);
		if (sequence === undefined) this.cursorInvalid();
		let outcome: number | "invalid";
		try {
			outcome = await this.file.update(
				(draft) => {
					if (sequence <= draft.acknowledged) return draft.acknowledged;
					if (!draft.entries.some((entry) => entry.sequence === sequence))
						return "invalid" as const;
					draft.acknowledged = sequence;
					draft.entries = draft.entries.filter(
						(entry) => entry.sequence > sequence,
					);
					return sequence;
				},
				{ skipUnchanged: true },
			);
		} catch {
			unavailable();
		}
		if (outcome === "invalid") this.cursorInvalid();
		return cursorOf(outcome);
	}

	close(): Promise<void> {
		return this.file.close();
	}

	private cursorInvalid(): never {
		throw new RuntimeHostError(
			"RUNTIME_SAFETY_EVIDENCE_CURSOR_INVALID",
			"Runtime safety evidence cursor is invalid",
			409,
		);
	}
}

/**
 * HLD §8.5.6 step 1: whether this Grant's subject and Agent fall in the deployment window at
 * `now`. Producers outside it give the helper only `unsupported` and create no evidence.
 */
export function runtimeSafetyEvidenceWindowAdmitsV1(input: {
	readonly window: RuntimeSafetyEvidenceWindowV1 | undefined;
	readonly agentId: string;
	readonly principalRef: string;
	readonly now: Date;
}): boolean {
	const { window } = input;
	if (!window) return false;
	const at = input.now.getTime();
	return (
		at >= Date.parse(window.opensAt) &&
		at <= Date.parse(window.closesAt) &&
		window.agentIds.includes(input.agentId) &&
		window.principalRefs.includes(input.principalRef)
	);
}
