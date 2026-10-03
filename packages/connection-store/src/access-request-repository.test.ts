import { expect, it, vi } from "vitest";

import { lookupApprovedConnectPermit } from "./access-request-repository";

it("rejects an approved profile containing multiple scopes in one entry", async () => {
	const sql = vi.fn().mockResolvedValue([
		{
			connect_expires_at: new Date(Date.now() + 60_000),
			provider_id: "github",
			provider_release_id: "github-release",
			required_scopes: ["repo delete_repo"],
		},
	]);
	await expect(
		lookupApprovedConnectPermit(
			sql as unknown as Parameters<typeof lookupApprovedConnectPermit>[0],
			"alice",
			"request-approved",
		),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
});
