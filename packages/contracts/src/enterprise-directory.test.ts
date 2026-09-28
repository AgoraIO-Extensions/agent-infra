import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { EnterpriseDirectorySnapshotV1Schema } from "./enterprise-directory.js";

describe("enterprise directory OpenAPI parity", () => {
	it("accepts and rejects the same directory response at the wire boundary", async () => {
		const document = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/enterprise-directory.v1.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const validate = new Ajv2020({
			strictSchema: false,
			validateFormats: false,
		}).compile({
			components: document.components,
			$ref: "#/components/schemas/EnterpriseDirectorySnapshotV1",
		});
		const current = {
			schemaVersion: 1,
			revision: "00000000-0000-4000-8000-000000000000",
			source: "wecom",
			rootDepartmentId: 1,
			fetchedAt: 1_000,
			validUntil: 2_000,
			complete: true,
			departments: [{ id: 1, name: "Company", parentId: 0 }],
			members: [
				{
					userId: "employee-a",
					email: "a@example.test",
					active: true,
					departmentIds: [1],
				},
			],
		};
		for (const [value, accepted] of [
			[current, true],
			[
				{ ...current, departments: [{ id: 1, name: "   ", parentId: 0 }] },
				false,
			],
			[
				{ ...current, members: [{ ...current.members[0], userId: "   " }] },
				false,
			],
			[{ ...current, complete: false }, false],
			[{ ...current, callerUserId: "forged" }, false],
		] as const) {
			expect(EnterpriseDirectorySnapshotV1Schema.safeParse(value).success).toBe(
				accepted,
			);
			expect(validate(value)).toBe(accepted);
		}
	});
});
