import { describe, expect, it } from "vitest";
import { createClient } from "../../pilot/generated-v2/client/index.js";
import type { SkillHubReviewQueueItemV1 } from "../../pilot/generated-v2/types.gen.js";
import { loadSkillReviewQueue } from "./skill-review-queue.js";

const item: SkillHubReviewQueueItemV1 = {
	schemaVersion: 1,
	skillId: "release-notes",
	skillVersionId: "release-notes-v2",
	name: "release-notes",
	provider: "github",
	version: "2.0.0",
	packageDigest: "a".repeat(64),
	manifestDigest: "b".repeat(64),
	signatureDigest: "c".repeat(64),
	visibility: "MEMBER",
	organizationId: null,
	state: "pending_review",
	ownerId: "user-other",
	submittedAt: "2026-10-01T00:00:00Z",
};

function fakeClient(handler: (request: Request) => Response) {
	const requests: Request[] = [];
	const client = createClient({
		baseUrl: "https://platform.example.test",
		fetch: async (input, init) => {
			const request = new Request(input, init);
			requests.push(request);
			return handler(request);
		},
	});
	return { client, requests };
}

describe("Skill review queue read", () => {
	it("reads every page through the opaque cursor before exposing items", async () => {
		const { client, requests } = fakeClient((request) =>
			Response.json(
				new URL(request.url).searchParams.get("cursor")
					? {
							items: [{ ...item, skillVersionId: "other-v1" }],
							nextCursor: null,
						}
					: { items: [item], nextCursor: "release-notes-v2" },
			),
		);
		await expect(loadSkillReviewQueue(client)).resolves.toEqual({
			kind: "ready",
			items: [item, { ...item, skillVersionId: "other-v1" }],
		});
		expect(requests.map((request) => request.url)).toEqual([
			"https://platform.example.test/api/v2/skills/reviews?limit=100",
			"https://platform.example.test/api/v2/skills/reviews?limit=100&cursor=release-notes-v2",
		]);
	});

	it.each([
		{ status: 401, reason: "authentication-required" },
		{ status: 403, reason: "denied" },
	])(
		"keeps HTTP $status as a non-retryable state",
		async ({ status, reason }) => {
			const { client } = fakeClient(() => Response.json({}, { status }));
			await expect(loadSkillReviewQueue(client)).resolves.toEqual({
				kind: "unavailable",
				retryable: false,
				reason,
			});
		},
	);

	it("throws a retryable error for dependency failures", async () => {
		const { client } = fakeClient(() => Response.json({}, { status: 503 }));
		await expect(loadSkillReviewQueue(client)).rejects.toMatchObject({
			retryable: true,
		});
	});

	it.each([
		[
			"published items",
			{ items: [{ ...item, state: "published" }], nextCursor: null },
		],
		[
			"unknown fields",
			{ items: [{ ...item, reviewReason: "x" }], nextCursor: null },
		],
		["a repeating cursor", { items: [item], nextCursor: "same" }],
	])("rejects %s as an invalid response", async (_name, body) => {
		const { client } = fakeClient(() => Response.json(body));
		await expect(loadSkillReviewQueue(client)).resolves.toEqual({
			kind: "unavailable",
			retryable: false,
			reason: "invalid-response",
		});
	});
});
