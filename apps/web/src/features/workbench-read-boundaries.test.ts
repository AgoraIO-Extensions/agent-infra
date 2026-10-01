import { AgentProjectionV2Schema } from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { describe, expect, it, vi } from "vitest";
import type { Client } from "../pilot/generated-v2/client/index.js";
import { createClient } from "../pilot/generated-v2/client/index.js";
import { loadPendingAgentApplications } from "./agent-administration/agent-administration.js";
import { loadAgentDiscovery } from "./agent-discovery/agent-discovery.js";
import { loadMyAgentApplications } from "./my-agents/my-agent-applications.js";
import { pendingApplication } from "./my-agents/test-fixtures.js";

const agent = AgentProjectionV2Schema.parse(
	pilotFakeScenariosV2.starting.response.body,
);
const readers = [
	{
		name: "visible Agents",
		item: agent,
		load: (client: Client, signal: AbortSignal) =>
			loadAgentDiscovery(client, "visible", signal),
	},
	{
		name: "Owner Agents",
		item: agent,
		load: (client: Client, signal: AbortSignal) =>
			loadAgentDiscovery(client, "owner", signal),
	},
	{
		name: "my applications",
		item: pendingApplication,
		load: (client: Client, signal: AbortSignal) =>
			loadMyAgentApplications(client, signal),
	},
	{
		name: "pending approvals",
		item: pendingApplication,
		load: (client: Client, signal: AbortSignal) =>
			loadPendingAgentApplications(client, signal),
	},
];

describe.each(readers)("Workbench read boundary: $name", ({ item, load }) => {
	it("does not fetch with an already cancelled login lifetime", async () => {
		const fetch = vi.fn(async () =>
			Response.json({ items: [item], nextCursor: null }),
		);
		const controller = new AbortController();
		controller.abort();
		const client = createClient({
			baseUrl: "https://platform.example.test",
			fetch,
		});
		await expect(load(client, controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it("forwards cancellation and discards a late successful response without fetching another page", async () => {
		const controller = new AbortController();
		const requests: Request[] = [];
		const client = createClient({
			baseUrl: "https://platform.example.test",
			fetch: async (request) => {
				requests.push(new Request(request));
				controller.abort();
				// This controlled transport deliberately ignores the abort.
				return Response.json({
					items: [item],
					nextCursor: requests.length === 1 ? "opaque-next/+?=" : null,
				});
			},
		});
		await expect(load(client, controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]?.signal.aborted).toBe(true);
	});

	it.each([
		{ status: 401, reason: "authentication-required" },
		{ status: 403, reason: "denied" },
		{ status: 404, reason: "not-found" },
	])(
		"discards prior pages on HTTP $status even when the error body is outside the contract",
		async ({ status, reason }) => {
			let requests = 0;
			const client = createClient({
				baseUrl: "https://platform.example.test",
				fetch: async () => {
					requests += 1;
					return requests === 1
						? Response.json({ items: [item], nextCursor: "opaque-next/+?=" })
						: Response.json(
								{ detail: "controlled opaque failure" },
								{ status },
							);
				},
			});
			await expect(load(client, new AbortController().signal)).resolves.toEqual(
				{
					kind: "unavailable",
					retryable: false,
					reason,
				},
			);
			expect(requests).toBe(2);
		},
	);
});
