import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
	newCallDiagnostics,
	observeProviderFetch,
	projectAuditDetail,
	withCallDiagnostics,
} from "@agent-infra/connection-core";
import {
	BitbucketServerAdapter,
	bitbucketServerConnectionCatalog,
} from "@agent-infra/openconnector-adapter";
import {
	createGuardedFetch,
	setDefaultGuardedFetchDnsLookup,
} from "@agent-infra/openconnector-kernel";
import { expect, it, vi } from "vitest";
import { createReadFallbackFetch } from "./runtime-app";

it("replays Bitbucket current-user through the real adapter, HTTP receiver and audit projection", async () => {
	setDefaultGuardedFetchDnsLookup(null);
	let count = 0;
	const server = createServer((req, res) => {
		count++;
		expect(req.headers.authorization).toBe("Bearer TOKEN-CANARY");
		res.setHeader("x-arequestid", `123x456x${count}`);
		if (req.url?.startsWith("/plugins/servlet/applinks/whoami"))
			res.end("fixture-user");
		else {
			res.setHeader("content-type", "application/json");
			res.end(
				JSON.stringify({
					isLastPage: true,
					values: [
						{
							active: true,
							displayName: "Fixture User",
							name: "fixture-user",
							id: 2588,
						},
					],
				}),
			);
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const localOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const transport: typeof fetch = async (input, init) => {
		const req = new Request(input, init);
		const original = new URL(req.url);
		return fetch(
			new Request(
				new URL(`${original.pathname}${original.search}`, localOrigin),
				req,
			),
		);
	};
	try {
		const adapter = new BitbucketServerAdapter(
			observeProviderFetch("bitbucket", transport),
		);
		const diagnostics = newCallDiagnostics("EXECUTE");
		const result = await withCallDiagnostics(diagnostics, () =>
			adapter.execute({
				action: "bitbucket.get_current_user",
				credential: { accessToken: "TOKEN-CANARY" },
				input: {},
			}),
		);
		const detail = projectAuditDetail({
			callId: "call-test",
			createdAt: new Date().toISOString(),
			principalId: "principal-test",
			person: "Test",
			email: null,
			consumerId: "consumer-test",
			consumer: "Codex",
			instanceId: "instance-test",
			actorKey: null,
			connectionId: "connection-test",
			providerId: "bitbucket",
			action: "bitbucket.get_current_user",
			actionVersionId: "bitbucket.get_current_user@v6",
			status: "SUCCEEDED",
			requestInput: {},
			inputSchema: bitbucketServerConnectionCatalog.actions.find(
				(action) => action.name === "bitbucket.get_current_user",
			)?.inputSchema,
			result,
			timeline: [],
			diagnosticRecords: [diagnostics],
		});
		expect(count).toBe(2);
		expect(detail.inputState).toBe("NO_PARAMETERS");
		expect(detail.output.length).toBeGreaterThan(0);
		expect(
			detail.diagnostics[0]?.requests.map((r) => r.requestIds[0]?.value),
		).toEqual(["123x456x1", "123x456x2"]);
		expect(JSON.stringify(detail)).not.toContain("TOKEN-CANARY");
		expect(JSON.stringify(detail)).not.toContain("fixture-user");
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		setDefaultGuardedFetchDnsLookup(undefined);
	}
});

it("records primary/fallback separately and excludes pre-transport guard rejections", async () => {
	const fallback = vi
		.fn<typeof fetch>()
		.mockResolvedValue(new Response(null, { status: 204 }));
	const transport = createReadFallbackFetch(
		observeProviderFetch("github", async () => {
			throw new TypeError("private-error");
		}),
		observeProviderFetch("github-fallback", fallback),
	);
	const group = newCallDiagnostics("EXECUTE");
	await withCallDiagnostics(group, () =>
		transport("https://api.github.com/user"),
	);
	const guarded = createGuardedFetch({
		fetch: observeProviderFetch("github", fallback),
		allowPrivateNetwork: false,
	});
	await expect(
		withCallDiagnostics(group, () => guarded("http://127.0.0.1/private")),
	).rejects.toThrow();
	await expect(
		withCallDiagnostics(group, () =>
			transport("https://api.github.com/user", { method: "POST" }),
		),
	).rejects.toThrow();
	expect(fallback).toHaveBeenCalledOnce();
	expect(group.requests.map((r) => [r.service, r.outcome])).toEqual([
		["github", "TRANSPORT_ERROR"],
		["github-fallback", "RESPONSE_HEADERS"],
		["github", "TRANSPORT_ERROR"],
	]);
});
