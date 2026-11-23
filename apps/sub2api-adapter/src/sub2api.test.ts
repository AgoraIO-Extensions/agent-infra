import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createSub2ApiAdapter } from "./sub2api.ts";

it("returns only eligible metadata for the provider-linked active account", async () => {
	const config = {
		instanceId: "relay",
		origin: "https://upstream.example",
		serviceBearer: randomUUID(),
		relayReadKey: randomUUID(),
		agentGroupIds: [8],
		accounts: { employee: 12 },
	};
	const keyValue = randomUUID();
	let owner = 12;
	let calls = 0;
	const handle = createSub2ApiAdapter(config, async (input, init) => {
		calls++;
		expect(new Headers(init?.headers).get("x-api-key")).toBe(
			config.relayReadKey,
		);
		const url = new URL(String(input));
		expect(url.origin).toBe(config.origin);
		if (url.pathname === "/api/v1/admin/users/12")
			return Response.json({ code: 0, data: { id: 12, status: "active" } });
		expect(url.pathname).toBe("/api/v1/admin/users/12/api-keys");
		const row = {
			id: 7,
			user_id: owner,
			status: "active",
			key: keyValue,
			group_id: 8,
			group: { id: 8, status: "active" },
			expires_at: null,
			quota: 0,
			quota_used: 0,
		};
		return Response.json({
			code: 0,
			data: {
				total: 3,
				items: [row, { ...row, id: 2 }, { ...row, id: 1, status: "disabled" }],
			},
		});
	});
	const discover = (subjectId: string, bearer: string = config.serviceBearer) =>
		handle(
			new Request("http://adapter/v1/model-authorizations", {
				method: "POST",
				headers: { authorization: `Bearer ${bearer}` },
				body: JSON.stringify({ schemaVersion: 1, subjectId }),
			}),
		);
	expect((await discover("employee", "unknown")).status).toBe(403);
	expect((await discover("unlinked")).status).toBe(403);
	expect(calls).toBe(0);
	const result = await (await discover("employee")).text();
	expect(result).not.toContain(keyValue);
	expect(JSON.parse(result).items.map((v: { ref: string }) => v.ref)).toEqual([
		"2",
		"7",
	]);
	owner = 66;
	expect((await discover("employee")).status).toBe(502);
});

it("rejects authenticated activation when the Relay cannot read the linked account", async () => {
	const token = randomUUID();
	const app = createSub2ApiAdapter(
		{
			instanceId: "relay",
			origin: "https://upstream.example",
			serviceBearer: token,
			relayReadKey: randomUUID(),
			agentGroupIds: [8],
			accounts: { employee: 12 },
		},
		async (input) => {
			if (new URL(String(input)).pathname === "/api/v1/settings/public")
				return Response.json({
					code: 0,
					data: { site_name: "Sub2API", version: "test" },
				});
			return new Response(null, { status: 403 });
		},
	);
	const url = "https://adapter.example/.well-known/agent-infra-adapter";
	expect((await app(new Request(url))).status).toBe(200);
	expect(
		(
			await app(
				new Request(url, { headers: { authorization: `Bearer ${token}` } }),
			)
		).status,
	).toBe(502);
});
