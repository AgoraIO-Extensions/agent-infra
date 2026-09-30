import { pilotBrowserHttpOpenApiPathsV2 } from "@agent-infra/contracts/pilot";
import type {
	Client,
	RequestResult,
} from "../../pilot/generated-v2/client/index.js";
import { listAdminAgentsV2 } from "../../pilot/generated-v2/sdk.gen.js";
import type {
	AgentProjectionV2,
	ListAdminAgentsV2Errors,
	ListAdminAgentsV2Responses,
} from "../../pilot/generated-v2/types.gen.js";

export type AdminAgentsState =
	| { kind: "ready"; agents: AgentProjectionV2[] }
	| { kind: "loading" }
	| { kind: "denied" }
	| { kind: "error"; retryable: boolean };

const adminAgentPageSchema =
	pilotBrowserHttpOpenApiPathsV2["/api/v2/admin/agents"].get.responses["200"]
		.content["application/json"].schema;
const maximumPages = 100;

/** Collect the complete server-authorized inventory before exposing any rows. */
export async function loadAdminAgents(
	client?: Client,
	signal?: AbortSignal,
): Promise<Exclude<AdminAgentsState, { kind: "loading" }>> {
	const agents: AgentProjectionV2[] = [];
	const cursors = new Set<string>();
	let cursor: string | null = null;

	for (let page = 0; page < maximumPages; page += 1) {
		signal?.throwIfAborted();
		const result: Awaited<
			RequestResult<ListAdminAgentsV2Responses, ListAdminAgentsV2Errors, false>
		> = await listAdminAgentsV2<false>({
			client,
			query: cursor === null ? {} : { cursor },
			signal,
			responseStyle: "fields",
			throwOnError: false,
		});
		// A transport may ignore cancellation and still resolve successfully.
		signal?.throwIfAborted();
		const status = result.response?.status;
		if (status === 401 || status === 403) return { kind: "denied" };
		if (status !== 200)
			return {
				kind: "error",
				retryable: status === undefined || status === 429 || status >= 500,
			};
		if (!result.data || !adminAgentPageSchema.safeParse(result.data).success)
			return { kind: "error", retryable: false };

		agents.push(...result.data.items);
		cursor = result.data.nextCursor;
		if (cursor === null) return { kind: "ready", agents };
		if (cursors.has(cursor)) return { kind: "error", retryable: false };
		cursors.add(cursor);
	}
	return { kind: "error", retryable: false };
}
