import {
	SkillHubDirectoryPageV1Schema,
	SkillHubVersionMetadataV1Schema,
} from "@agent-infra/contracts/pilot";
import type {
	Client,
	RequestResult,
} from "../../pilot/generated-v2/client/index.js";
import {
	listSkillHubVersionsV1,
	readSkillHubVersionV1,
} from "../../pilot/generated-v2/sdk.gen.js";
import type {
	ListSkillHubVersionsV1Data,
	ListSkillHubVersionsV1Errors,
	ListSkillHubVersionsV1Responses,
	ReadSkillHubVersionV1Errors,
	ReadSkillHubVersionV1Responses,
	SkillHubVersionMetadataV1,
} from "../../pilot/generated-v2/types.gen.js";
import {
	type CollectionReadUnavailable,
	collectionReadFailure,
} from "../collection-read-failure.js";

export type SkillHubDirectoryState =
	| { kind: "ready"; versions: SkillHubVersionMetadataV1[] }
	| CollectionReadUnavailable;

export type SkillHubVersionState =
	| { kind: "ready"; version: SkillHubVersionMetadataV1 }
	| CollectionReadUnavailable;

const maximumSkillHubPages = 100;

function retryableError() {
	return Object.assign(new Error("Skill Hub data is temporarily unavailable"), {
		retryable: true as const,
	});
}

function unavailable(
	error:
		| { retryable?: boolean; reason?: CollectionReadUnavailable["reason"] }
		| undefined,
) {
	if (error?.retryable !== false) throw retryableError();

	return {
		kind: "unavailable" as const,
		retryable: false,
		...(error?.reason ? { reason: error.reason } : {}),
	};
}

export function isRetryableSkillHubError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(!("retryable" in error) || error.retryable === true)
	);
}

/** Read the complete server-authorized catalog before exposing any rows. */
export async function loadSkillHubDirectory(
	client?: Client,
	signal?: AbortSignal,
): Promise<SkillHubDirectoryState> {
	const versions: SkillHubVersionMetadataV1[] = [];
	const cursors = new Set<string>();
	let cursor: string | null = null;

	for (let page = 0; page < maximumSkillHubPages; page += 1) {
		signal?.throwIfAborted();
		const query: ListSkillHubVersionsV1Data["query"] =
			cursor === null ? {} : { cursor };
		const result: Awaited<
			RequestResult<
				ListSkillHubVersionsV1Responses,
				ListSkillHubVersionsV1Errors,
				false
			>
		> = await listSkillHubVersionsV1<false>({
			client,
			query,
			signal,
			responseStyle: "fields",
			throwOnError: false,
		});
		signal?.throwIfAborted();
		const status = result.response?.status;
		if (status !== 200) return unavailable(collectionReadFailure(status));
		if (
			!result.data ||
			!SkillHubDirectoryPageV1Schema.safeParse(result.data).success
		)
			return unavailable({ retryable: false, reason: "invalid-response" });

		versions.push(...result.data.items);
		cursor = result.data.nextCursor;
		if (cursor === null) return { kind: "ready", versions };
		if (cursors.has(cursor)) return unavailable({ retryable: false });
		cursors.add(cursor);
	}

	return unavailable({ retryable: false });
}

export async function loadSkillHubVersion(
	skillVersionId: string,
	client?: Client,
	signal?: AbortSignal,
): Promise<SkillHubVersionState> {
	signal?.throwIfAborted();
	const result: Awaited<
		RequestResult<
			ReadSkillHubVersionV1Responses,
			ReadSkillHubVersionV1Errors,
			false
		>
	> = await readSkillHubVersionV1<false>({
		client,
		path: { skillVersionId },
		signal,
		responseStyle: "fields",
		throwOnError: false,
	});
	signal?.throwIfAborted();
	const status = result.response?.status;
	if (status !== 200) return unavailable(collectionReadFailure(status));
	const parsed = SkillHubVersionMetadataV1Schema.safeParse(result.data);
	if (!parsed.success || parsed.data.skillVersionId !== skillVersionId)
		return unavailable({ retryable: false, reason: "invalid-response" });
	return { kind: "ready", version: parsed.data };
}
