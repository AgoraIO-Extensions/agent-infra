import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Platform browser authentication wire contract", () => {
	it("publishes OIDC redirects, back-channel logout and same-origin session logout", async () => {
		const artifact = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/platform-auth.v2.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		expect(artifact.info.version).toBe("2.0.0");
		expect(artifact.openapi).toBe("3.1.0");
		expect(artifact.paths["/auth/login"]).toBeUndefined();
		for (const path of ["/auth/oidc/login", "/auth/oidc/callback"])
			expect(artifact.paths[path].get.responses["303"]).toBeTruthy();
		expect(
			artifact.paths["/auth/oidc/backchannel-logout"].post.requestBody.content[
				"application/x-www-form-urlencoded"
			].schema.required,
		).toEqual(["logout_token"]);
		expect(artifact.paths["/auth/logout"].post.security).toEqual([
			{ PlatformSession: [] },
		]);
		expect(artifact.paths["/auth/logout"].post.parameters[0].schema).toEqual({
			type: "string",
			const: "1",
		});
	});
});
