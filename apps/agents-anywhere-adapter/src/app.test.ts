import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAgentsAnywhereAdapter } from "./app.js";

const origin = "https://agents-anywhere.example.test";
const worker = randomUUID();
const accessToken = randomUUID();
let folder: string;
let configPath: string;
let grantFile: string;
beforeEach(async () => {
	folder = await mkdtemp(join(tmpdir(), "aa-directory-"));
	configPath = join(folder, "accounts.json");
	grantFile = join(folder, "grant.json");
	const workerTokenFile = join(folder, "worker");
	await writeFile(workerTokenFile, worker, { mode: 0o600 });
	await writeFile(grantFile, JSON.stringify({ origin, accessToken }), {
		mode: 0o600,
	});
	await writeFile(
		configPath,
		JSON.stringify({
			instanceId: "workstations",
			origin,
			workerTokenFile,
			accounts: [{ subjectId: "employee", userId: "aa-owner", grantFile }],
		}),
	);
});
afterEach(async () => {
	await rm(folder, { recursive: true, force: true });
});
const native = (
	change: {
		deviceOwner?: string;
		accountOwner?: string;
		runtimeDevice?: string;
		disabled?: boolean;
		offline?: boolean;
	} = {},
) =>
	vi.fn<typeof fetch>(async (input, init) => {
		expect(new URL(String(input)).origin).toBe(origin);
		expect(new Headers(init?.headers).get("authorization")).toBe(
			`Bearer ${accessToken}`,
		);
		expect(init?.redirect).toBe("error");
		switch (new URL(String(input)).pathname) {
			case "/api/v2/auth/me":
				return Response.json({
					userId: change.accountOwner ?? "aa-owner",
					disabled: change.disabled ?? false,
					email: "private@example.test",
				});
			case "/api/v2/connectors":
				return Response.json({
					connectors: [
						{
							id: "device-1",
							userId: change.deviceOwner ?? "aa-owner",
							name: "Mac",
							status: change.offline ? "offline" : "online",
						},
					],
				});
			case "/api/v2/connectors/device-1/runtimes":
				return Response.json({
					connectorId: "device-1",
					runtimes: [
						{
							connectorId: change.runtimeDevice ?? "device-1",
							runtimeId: "rti_1",
							name: "Codex",
							status: "running",
							available: true,
							present: true,
							active: true,
							configured: true,
							config: { privateValue: "fixture" },
							secretFields: { privateHint: "fixture" },
						},
					],
				});
			default:
				throw Error("Unexpected native request");
		}
	});
function query(
	app: ReturnType<typeof createAgentsAnywhereAdapter>,
	subjectId = "employee",
	token = worker,
) {
	return app.request("/v1/resources/query", {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ schemaVersion: 1, subjectId }),
	});
}
it.each([false, true])(
	"projects the same native target when offline is %s",
	async (offline) => {
		const upstream = native({ offline });
		const app = createAgentsAnywhereAdapter(configPath, upstream);
		const manifest = await app.request("/.well-known/agent-infra-adapter", {
			headers: { authorization: `Bearer ${worker}` },
		});
		expect(await manifest.json()).toEqual({
			schemaVersion: 1,
			instanceId: "workstations",
			capabilities: ["discovery"],
		});
		const response = await query(app);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			schemaVersion: 1,
			instanceId: "workstations",
			subjectId: "employee",
			devices: [
				{
					ref: "device-1",
					displayName: "Mac",
					status: offline ? "offline" : "online",
					runtimes: [
						{
							ref: "rti_1",
							displayName: "Codex",
							status: offline ? "unavailable" : "available",
							capabilities: ["execute"],
						},
					],
				},
			],
		});
		expect(upstream).toHaveBeenCalledTimes(3);
	},
);
it("requires the Worker credential and a current association before contacting the provider", async () => {
	const upstream = native();
	const app = createAgentsAnywhereAdapter(configPath, upstream);
	expect((await query(app, "employee", accessToken)).status).toBe(401);
	expect(await (await query(app, "other")).json()).toMatchObject({
		subjectId: "other",
		devices: [],
	});
	await writeFile(
		grantFile,
		JSON.stringify({ origin: "https://previous.example.test", accessToken }),
	);
	expect((await query(app)).status).toBe(403);
	expect(upstream).not.toHaveBeenCalled();
});
it.each([
	{ accountOwner: "another" },
	{ disabled: true },
	{ deviceOwner: "another" },
	{ runtimeDevice: "other-device" },
])(
	"rejects a mismatched or disabled upstream owner or device",
	async (mismatch) => {
		const response = await query(
			createAgentsAnywhereAdapter(configPath, native(mismatch)),
		);
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "forbidden" });
	},
);
