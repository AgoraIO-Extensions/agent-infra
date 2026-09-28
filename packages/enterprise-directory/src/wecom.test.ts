import { describe, expect, it } from "vitest";
import { createWeComSource } from "./wecom.js";

function source(responses: Record<string, unknown>) {
	return createWeComSource({
		corpId: "test-corp",
		corpSecret: "test-secret",
		rootDepartmentId: 1,
		fetch: async (input) => {
			const url = new URL(String(input));
			const key = `${url.pathname}:${url.searchParams.get("department_id") ?? ""}`;
			return Response.json(responses[key] ?? { errcode: 60011 });
		},
	});
}

const complete = {
	"/cgi-bin/gettoken:": { errcode: 0, access_token: "source-token" },
	"/cgi-bin/department/list:": {
		errcode: 0,
		department: [
			{ id: 1, name: "Company", parentid: 0 },
			{ id: 2, name: "Engineering", parentid: 1 },
		],
	},
	"/cgi-bin/user/list:1": {
		errcode: 0,
		userlist: [
			{ userid: "u1", email: "u1@example.test", status: 1, department: [1, 2] },
		],
	},
	"/cgi-bin/user/list:2": {
		errcode: 0,
		userlist: [
			{ userid: "u1", email: "u1@example.test", status: 1, department: [1, 2] },
			{ userid: "u2", email: "", status: 2, department: [2] },
		],
	},
};

describe("WeCom complete fetch", () => {
	it("deduplicates consistent members across departments", async () => {
		const result = await source(complete).fetchComplete();
		expect(result.departments).toHaveLength(2);
		expect(result.members).toEqual([
			{
				userId: "u1",
				email: "u1@example.test",
				active: true,
				departmentIds: [1, 2],
			},
			{ userId: "u2", email: "", active: false, departmentIds: [2] },
		]);
	});

	it("rejects denied department, malformed user and inconsistent repeated member", async () => {
		for (const failed of [
			{ ...complete, "/cgi-bin/user/list:2": { errcode: 60011 } },
			{ ...complete, "/cgi-bin/user/list:2": { errcode: 0, userlist: [{}] } },
			{
				...complete,
				"/cgi-bin/user/list:2": {
					errcode: 0,
					userlist: [
						{
							userid: "u1",
							email: "other@example.test",
							status: 1,
							department: [1, 2],
						},
					],
				},
			},
		]) {
			await expect(source(failed).fetchComplete()).rejects.toThrow();
		}
	});
});
