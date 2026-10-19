import {
	SkillHubOwnedVersionV1Schema,
	SkillHubVersionDetailV1Schema,
	SkillHubVersionMetadataV1Schema,
} from "@agent-infra/contracts/pilot";
import { describe, expect, it } from "vitest";
import { createClient } from "../../pilot/generated-v2/client/index.js";
import {
	loadOwnedSkillHubVersions,
	loadSkillHubDirectory,
	loadSkillHubVersion,
} from "./skill-hub.js";

const version = SkillHubVersionMetadataV1Schema.parse({
	schemaVersion: 1,
	skillId: "release-notes",
	skillVersionId: "release-notes-v1",
	provider: "my_library",
	version: "1.2.0",
	packageDigest: "a".repeat(64),
	manifestDigest: "b".repeat(64),
	signatureDigest: "c".repeat(64),
	name: "release-notes",
	visibility: "PRIVATE",
	state: "published",
});

function fakeClient(
	handler: (request: Request) => Response | Promise<Response>,
) {
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

describe("Skill Hub read boundary", () => {
	it("collects every authorized page and forwards the opaque cursor", async () => {
		const { client, requests } = fakeClient((request) => {
			const cursor = new URL(request.url).searchParams.get("cursor");
			return Response.json(
				cursor
					? { items: [version], nextCursor: null }
					: { items: [version], nextCursor: "next-version" },
			);
		});

		await expect(loadSkillHubDirectory(client)).resolves.toEqual({
			kind: "ready",
			versions: [version, version],
		});
		expect(requests.map((request) => request.url)).toEqual([
			"https://platform.example.test/api/v2/skills",
			"https://platform.example.test/api/v2/skills?cursor=next-version",
		]);
	});

	it.each([
		{ status: 401, reason: "authentication-required" },
		{ status: 403, reason: "denied" },
		{ status: 404, reason: "not-found" },
	])(
		"preserves HTTP $status as a non-retryable catalog state",
		async ({ status, reason }) => {
			const { client } = fakeClient(() => Response.json({}, { status }));
			await expect(loadSkillHubDirectory(client)).resolves.toEqual({
				kind: "unavailable",
				retryable: false,
				reason,
			});
		},
	);

	it("rejects malformed metadata without exposing a partial page", async () => {
		const { client } = fakeClient(() =>
			Response.json({
				items: [{ ...version, packageDigest: "not-a-digest" }],
				nextCursor: null,
			}),
		);
		await expect(loadSkillHubDirectory(client)).resolves.toEqual({
			kind: "unavailable",
			retryable: false,
			reason: "invalid-response",
		});
	});

	it("cancels before dispatch and forwards late cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		const { client, requests } = fakeClient(() =>
			Response.json({ items: [], nextCursor: null }),
		);
		await expect(
			loadSkillHubDirectory(client, controller.signal),
		).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(requests).toHaveLength(0);
	});

	it("reads one version detail and rejects a response for another version id", async () => {
		// 详情页改读版本详情投影（#2904），同一套 ID 核对与失败映射。
		const detail = SkillHubVersionDetailV1Schema.parse({
			...version,
			ownerId: "user-owner",
			installation: { state: "not_installed" },
			content: { state: "unavailable" },
		});
		const { client, requests } = fakeClient(() => Response.json(detail));
		await expect(
			loadSkillHubVersion(version.skillVersionId, client),
		).resolves.toEqual({
			kind: "ready",
			version: detail,
		});
		expect(requests[0]?.url).toBe(
			"https://platform.example.test/api/v2/skills/versions/release-notes-v1/detail",
		);
		await expect(loadSkillHubVersion("other-version", client)).resolves.toEqual(
			{
				kind: "unavailable",
				retryable: false,
				reason: "invalid-response",
			},
		);
		// 旧的 metadata 形状缺少发布者、安装与内容，不能当作详情接受。
		const { client: legacy } = fakeClient(() => Response.json(version));
		await expect(
			loadSkillHubVersion(version.skillVersionId, legacy),
		).resolves.toEqual({
			kind: "unavailable",
			retryable: false,
			reason: "invalid-response",
		});
	});

	it("collects every page of the user's own versions in any state", async () => {
		const pending = SkillHubOwnedVersionV1Schema.parse({
			...version,
			skillVersionId: "release-notes-v2",
			state: "pending_review",
		});
		const { client, requests } = fakeClient((request) =>
			Response.json(
				new URL(request.url).searchParams.get("cursor")
					? { items: [pending], nextCursor: null }
					: { items: [version], nextCursor: "release-notes-v1" },
			),
		);
		await expect(loadOwnedSkillHubVersions(client)).resolves.toEqual({
			kind: "ready",
			versions: [version, pending],
		});
		expect(requests.map((request) => request.url)).toEqual([
			"https://platform.example.test/api/v2/skills/owned-versions",
			"https://platform.example.test/api/v2/skills/owned-versions?cursor=release-notes-v1",
		]);
		const { client: denied } = fakeClient(() =>
			Response.json({}, { status: 403 }),
		);
		await expect(loadOwnedSkillHubVersions(denied)).resolves.toEqual({
			kind: "unavailable",
			retryable: false,
			reason: "denied",
		});
	});

	it("does not silently retry a repeated cursor", async () => {
		const { client } = fakeClient(() =>
			Response.json({ items: [version], nextCursor: "same-cursor" }),
		);
		await expect(loadSkillHubDirectory(client)).resolves.toEqual({
			kind: "unavailable",
			retryable: false,
		});
	});

	it("exposes retryable transport failures for the query layer", async () => {
		const { client } = fakeClient(() => {
			throw new Error("network down");
		});
		await expect(loadSkillHubDirectory(client)).rejects.toMatchObject({
			retryable: true,
		});
	});
});
