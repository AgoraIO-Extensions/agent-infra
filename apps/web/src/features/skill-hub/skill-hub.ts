import {
	SkillHubDirectoryPageV1Schema,
	SkillHubOwnedVersionPageV1Schema,
	SkillHubVersionDetailV1Schema,
} from "@agent-infra/contracts/pilot";
import type { Client } from "../../pilot/generated-v2/client/index.js";
import {
	listOwnedSkillHubVersionsV1,
	listSkillHubVersionsV1,
	readSkillHubVersionDetailV1,
} from "../../pilot/generated-v2/sdk.gen.js";
import type {
	SkillHubOwnedVersionV1,
	SkillHubVersionDetailV1,
	SkillHubVersionMetadataV1,
} from "../../pilot/generated-v2/types.gen.js";
import {
	type CollectionReadUnavailable,
	collectionReadFailure,
} from "../collection-read-failure.js";

export type SkillHubDirectoryState =
	| { kind: "ready"; versions: SkillHubVersionMetadataV1[] }
	| CollectionReadUnavailable;

/** 当前用户自己的版本（含审核中、已驳回、已撤销）。 */
export type SkillHubOwnedVersionsState =
	| { kind: "ready"; versions: SkillHubOwnedVersionV1[] }
	| CollectionReadUnavailable;

export type SkillHubVersionState =
	| { kind: "ready"; version: SkillHubVersionDetailV1 }
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

type PageResult = {
	data?: unknown;
	response?: Response;
};

/** 读完服务端授权的全部分页后才暴露结果；游标重复或页数超限时不静默截断。 */
async function collectPages<T>(
	readPage: (
		query: { cursor?: string },
		signal?: AbortSignal,
	) => Promise<PageResult>,
	parse: (
		data: unknown,
	) => { items: T[]; nextCursor: string | null } | undefined,
	signal?: AbortSignal,
): Promise<{ kind: "ready"; versions: T[] } | CollectionReadUnavailable> {
	const versions: T[] = [];
	const cursors = new Set<string>();
	let cursor: string | null = null;

	for (let page = 0; page < maximumSkillHubPages; page += 1) {
		signal?.throwIfAborted();
		const result = await readPage(cursor === null ? {} : { cursor }, signal);
		signal?.throwIfAborted();
		const status = result.response?.status;
		if (status !== 200) return unavailable(collectionReadFailure(status));
		const parsed = result.data ? parse(result.data) : undefined;
		if (!parsed)
			return unavailable({ retryable: false, reason: "invalid-response" });

		versions.push(...parsed.items);
		cursor = parsed.nextCursor;
		if (cursor === null) return { kind: "ready", versions };
		if (cursors.has(cursor)) return unavailable({ retryable: false });
		cursors.add(cursor);
	}

	return unavailable({ retryable: false });
}

/** Read the complete server-authorized catalog before exposing any rows. */
export function loadSkillHubDirectory(
	client?: Client,
	signal?: AbortSignal,
): Promise<SkillHubDirectoryState> {
	return collectPages(
		(query, pageSignal) =>
			listSkillHubVersionsV1<false>({
				client,
				query,
				signal: pageSignal,
				responseStyle: "fields",
				throwOnError: false,
			}),
		(data) => {
			const parsed = SkillHubDirectoryPageV1Schema.safeParse(data);
			return parsed.success ? parsed.data : undefined;
		},
		signal,
	);
}

/** 读完当前用户自己的全部版本；服务端按会话主体过滤，页面不提交主体。 */
export function loadOwnedSkillHubVersions(
	client?: Client,
	signal?: AbortSignal,
): Promise<SkillHubOwnedVersionsState> {
	return collectPages(
		(query, pageSignal) =>
			listOwnedSkillHubVersionsV1<false>({
				client,
				query,
				signal: pageSignal,
				responseStyle: "fields",
				throwOnError: false,
			}),
		(data) => {
			const parsed = SkillHubOwnedVersionPageV1Schema.safeParse(data);
			return parsed.success ? parsed.data : undefined;
		},
		signal,
	);
}

/** 版本详情：含有界正文、资源清单、发布者与本人安装状态。 */
export async function loadSkillHubVersion(
	skillVersionId: string,
	client?: Client,
	signal?: AbortSignal,
): Promise<SkillHubVersionState> {
	signal?.throwIfAborted();
	const result = await readSkillHubVersionDetailV1<false>({
		client,
		path: { skillVersionId },
		signal,
		responseStyle: "fields",
		throwOnError: false,
	});
	signal?.throwIfAborted();
	const status = result.response?.status;
	if (status !== 200) return unavailable(collectionReadFailure(status));
	const parsed = SkillHubVersionDetailV1Schema.safeParse(result.data);
	if (!parsed.success || parsed.data.skillVersionId !== skillVersionId)
		return unavailable({ retryable: false, reason: "invalid-response" });
	return { kind: "ready", version: parsed.data };
}
