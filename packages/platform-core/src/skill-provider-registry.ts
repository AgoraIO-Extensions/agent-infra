import {
	MagicSkillProviderOrderV1,
	type SkillProviderIdV1,
} from "./skill-hub.js";
import { SkillHubOperationErrorV1 } from "./skill-hub-management.js";

export type SkillProviderCandidateV1 = Readonly<{
	provider: SkillProviderIdV1;
	name: string;
	version: string;
	sourceVersion: string;
	sourceDigest: string;
	approvalRef: string | null;
	archiveBytes: Uint8Array;
}>;

export interface SkillProviderAdapterV1 {
	discover(): Promise<readonly SkillProviderCandidateV1[]>;
}

export type SkillProviderRegistryV1 = Readonly<{
	providers: readonly SkillProviderIdV1[];
	discover(): Promise<readonly SkillProviderCandidateV1[]>;
}>;

export type SkillProviderBatchResultV1 = Readonly<{
	index: number;
	provider: SkillProviderIdV1 | null;
	status: "succeeded" | "failed";
	archiveDigest: string | null;
	errorCode: string | null;
}>;

export type SkillProviderBatchRunnerV1 = (
	candidate: SkillProviderCandidateV1,
	index: number,
) => Promise<SkillProviderBatchResultV1>;

function invalid(): never {
	throw new SkillHubOperationErrorV1("invalid_input");
}

function digest(value: unknown): string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) invalid();
	return value;
}

function candidate(value: SkillProviderCandidateV1): SkillProviderCandidateV1 {
	if (
		!MagicSkillProviderOrderV1.some((item) => item === value.provider) ||
		!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(value.name) ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.version) ||
		typeof value.sourceVersion !== "string" ||
		value.sourceVersion.length === 0 ||
		value.sourceVersion.length > 1024 ||
		!value.sourceVersion.isWellFormed() ||
		(value.approvalRef !== null &&
			(typeof value.approvalRef !== "string" ||
				value.approvalRef.length === 0 ||
				value.approvalRef.length > 256)) ||
		!(value.archiveBytes instanceof Uint8Array) ||
		value.archiveBytes.byteLength === 0 ||
		value.archiveBytes.byteLength > 50_000_000
	)
		invalid();
	return Object.freeze({
		...value,
		sourceDigest: digest(value.sourceDigest),
		archiveBytes: Uint8Array.from(value.archiveBytes),
	});
}

export function createSkillProviderRegistryV1(
	adapters: Readonly<
		Partial<Record<SkillProviderIdV1, SkillProviderAdapterV1>>
	>,
): SkillProviderRegistryV1 {
	const configured = new Map<SkillProviderIdV1, SkillProviderAdapterV1>();
	for (const provider of MagicSkillProviderOrderV1) {
		const adapter = adapters[provider];
		if (adapter !== undefined) configured.set(provider, adapter);
	}
	return Object.freeze({
		providers: Object.freeze([...configured.keys()]),
		async discover() {
			const result: SkillProviderCandidateV1[] = [];
			for (const provider of MagicSkillProviderOrderV1) {
				const adapter = configured.get(provider);
				if (!adapter) continue;
				const candidates = await adapter.discover();
				for (const item of candidates) {
					const normalized = candidate(item);
					if (normalized.provider !== provider) invalid();
					result.push(normalized);
				}
			}
			return Object.freeze(result);
		},
	});
}

export async function runSkillProviderBatchV1(
	candidatesInput: readonly SkillProviderCandidateV1[],
	run: SkillProviderBatchRunnerV1,
	options: Readonly<{ concurrency?: number }> = {},
): Promise<readonly SkillProviderBatchResultV1[]> {
	if (
		!Array.isArray(candidatesInput) ||
		candidatesInput.length > 10 ||
		!Number.isSafeInteger(options.concurrency ?? 3) ||
		(options.concurrency ?? 3) < 1 ||
		(options.concurrency ?? 3) > 3
	)
		invalid();
	const candidates = candidatesInput.map(candidate);
	const results: SkillProviderBatchResultV1[] = [];
	let next = 0;
	async function worker() {
		while (true) {
			const index = next++;
			if (index >= candidates.length) return;
			const item = candidates[index];
			if (!item) return;
			try {
				const result = await run(item, index);
				const valid =
					result.index === index &&
					result.provider === item.provider &&
					((result.status === "succeeded" &&
						typeof result.archiveDigest === "string" &&
						/^[a-f0-9]{64}$/.test(result.archiveDigest) &&
						result.errorCode === null) ||
						(result.status === "failed" &&
							result.archiveDigest === null &&
							typeof result.errorCode === "string" &&
							result.errorCode.length > 0));
				if (!valid) throw new SkillHubOperationErrorV1("unavailable");
				results[index] = Object.freeze({ ...result });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: "unavailable";
				results[index] = Object.freeze({
					index,
					provider: item.provider,
					status: "failed",
					archiveDigest: null,
					errorCode: code,
				});
			}
		}
	}
	await Promise.all(
		Array.from(
			{ length: Math.min(options.concurrency ?? 3, candidates.length) },
			() => worker(),
		),
	);
	return Object.freeze(results);
}
