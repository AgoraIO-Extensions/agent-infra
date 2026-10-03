import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PlatformLoginRequestV1Schema } from "./platform-auth.js";

describe("Platform browser authentication wire contract", () => {
	it("accepts only login credentials without caller identity fields", () => {
		expect(
			PlatformLoginRequestV1Schema.safeParse({
				login: "employee-a",
				password: "candidate-password",
			}).success,
		).toBe(true);
		for (const input of [
			{ login: "employee-a", password: "candidate-password", userId: "admin" },
			{ login: "", password: "candidate-password" },
			{ login: "employee-a", password: "" },
		])
			expect(PlatformLoginRequestV1Schema.safeParse(input).success).toBe(false);
	});

	it("publishes JSON POST login and same-origin POST logout", async () => {
		const artifact = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/platform-auth.v1.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		expect(artifact.openapi).toBe("3.1.0");
		expect(Object.keys(artifact.paths["/auth/login"])).toEqual(["post"]);
		expect(Object.keys(artifact.paths["/auth/logout"])).toEqual(["post"]);
		expect(
			artifact.paths["/auth/login"].post.requestBody.content[
				"application/json"
			],
		).toBeTruthy();
		expect(artifact.paths["/auth/logout"].post.security).toEqual([
			{ PlatformSession: [] },
		]);
		expect(artifact.paths["/auth/logout"].post.parameters[0].schema).toEqual({
			type: "string",
			const: "1",
		});
	});
});
