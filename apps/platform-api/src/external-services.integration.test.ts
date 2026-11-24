import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import {
	ExternalServiceStore,
	migratePlatformDatabase,
} from "@agent-infra/platform-store";
import { createSecretEncryptorV1 } from "@agent-infra/secret-store";
import { createWorkloadSecretKeyringDecryptorV1 } from "@agent-infra/secret-store/worker";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import {
	openPostgresTestClient,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import { createExternalServiceProbe } from "../../platform-worker/src/external-service-probe.js";

import { HttpProtocolError } from "./http/common.js";
import { registerExternalServiceRoutes } from "./http/external-service-routes.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
	modulusLength: 3072,
});
const publicDer = publicKey.export({ format: "der", type: "spki" });
const encryptor = createSecretEncryptorV1({
	encryptionKeys: {
		schemaVersion: 1,
		activeWrappingKeyVersion: "test-key",
		keys: [
			{
				schemaVersion: 1,
				keyVersion: "test-key",
				wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
				publicKeySpkiDerBase64: publicDer.toString("base64"),
				publicKeyFingerprint: createHash("sha256")
					.update(publicDer)
					.digest("hex"),
				rsaModulusBits: 3072,
				status: "active",
			},
		],
	},
});
const decryptor = createWorkloadSecretKeyringDecryptorV1({
	keys: [
		{
			keyVersion: "test-key",
			privateKeyPkcs8DerBase64: privateKey
				.export({ format: "der", type: "pkcs8" })
				.toString("base64"),
		},
	],
});
async function provider(
	name: string,
	options: { credential?: string; echo?: "ref" | "displayName" } = {},
) {
	const credential = options.credential ?? randomUUID();
	const calls: string[] = [];
	let valid = true;
	let foreign = false;
	const server = createServer(async (req, res) => {
		calls.push(req.url ?? "");
		if (req.headers.authorization !== `Bearer ${credential}`) {
			res.writeHead(403).end();
			return;
		}
		res.setHeader("content-type", "application/json");
		if (req.url === "/.well-known/agent-infra-adapter") {
			res.end(
				JSON.stringify({
					schemaVersion: 1,
					instanceId: valid ? "relay" : "other",
					capabilities: ["model-authorization"],
				}),
			);
			return;
		}
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const { subjectId } = JSON.parse(raw);
		res.end(
			JSON.stringify({
				schemaVersion: 1,
				instanceId: "relay",
				subjectId: foreign ? "other-user" : subjectId,
				items: [
					{
						ref: name,
						displayName: name,
						...(options.echo ? { [options.echo]: credential } : {}),
					},
				],
			}),
		);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string")
		throw Error("listener unavailable");
	return {
		credential,
		calls,
		origin: `https://${name}.example.test`,
		local: `http://127.0.0.1:${address.port}`,
		foreign: (value: boolean) => {
			foreign = value;
		},
		valid: (value: boolean) => {
			valid = value;
		},
		close: () =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
	};
}
it("routes employee discovery to the verified provider across cutover and component restart", async () => {
	const db = await startPostgresTestDatabase("external-service-cutover");
	const sql = openPostgresTestClient(db);
	const a = await provider("a");
	const b = await provider("b");
	let store = new ExternalServiceStore(db.databaseUrl);
	let worker!: ReturnType<typeof createExternalServiceProbe>;
	function assemble() {
		worker = createExternalServiceProbe(store, decryptor, (input, init) => {
			const url = new URL(String(input));
			const target = [a, b].find((p) => p.origin === url.origin);
			if (!target) throw Error("unexpected destination");
			return fetch(new URL(url.pathname, target.local), init);
		});
		const app = new Hono();
		app.onError((error, c) =>
			error instanceof HttpProtocolError
				? c.json(error.body, error.status)
				: c.body(null, 500),
		);
		registerExternalServiceRoutes(
			app,
			{
				resolve: async (request) => {
					const admin = request.headers.get("cookie") === "fixture=admin";
					return {
						schemaVersion: 1,
						userId: admin ? "admin" : "employee",
						displayName: "tester",
						accountStatus: "active",
						organizationIds: [],
						roles: [admin ? "system_admin" : "employee"],
						authorizationRevision: "1",
					};
				},
				hydrateUsers: async () => [],
			},
			{
				store,
				encryptor,
			},
		);
		return app;
	}
	let app = assemble();
	let pending: Promise<void> | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	function start() {
		return setInterval(() => {
			if (!pending)
				pending = worker().finally(() => {
					pending = undefined;
				});
		}, 30);
	}
	const path = "/api/v2/admin/external-services";
	const call = (url: string, body?: object, admin = true) =>
		app.request(url, {
			method: body ? "POST" : "GET",
			headers: {
				"content-type": "application/json",
				cookie: admin ? "fixture=admin" : "fixture=user",
			},
			...(body ? { body: JSON.stringify(body) } : {}),
		});
	const command = (revision: number, action: string) =>
		call(`${path}/commands`, { id: "relay", revision, action });
	const save = (expectedRevision: number, target: typeof a) =>
		call(path, {
			id: "relay",
			url: target.origin,
			credential: target.credential,
			expectedRevision,
			modelEndpointId: "fixture-endpoint",
		});
	const discover = () =>
		call("/api/v2/me/external-service-authorizations", { id: "relay" }, false);
	try {
		await migratePlatformDatabase({ databaseUrl: db.databaseUrl });
		timer = start();
		expect((await call(path, undefined, false)).status).toBe(403);
		expect((await call(path, { id: "relay" }, false)).status).toBe(403);
		expect((await save(0, a)).status).toBe(200);
		expect((await command(1, "test")).status).toBe(200);
		expect((await command(1, "enable")).status).toBe(200);
		expect((await discover()).status).toBe(200);
		expect((await save(1, b)).status).toBe(200);
		b.valid(false);
		expect((await command(2, "test")).status).toBe(503);
		expect((await command(2, "enable")).status).toBe(409);
		expect(await (await discover()).json()).toMatchObject({
			revision: 1,
			discovery: { subjectId: "employee", items: [{ ref: "a" }] },
		});
		b.valid(true);
		expect((await command(2, "test")).status).toBe(200);
		clearInterval(timer);
		await pending;
		// Roll back the first receipt after A has answered. The original row survives.
		await sql`create function reject_fixture_receipt() returns trigger language plpgsql as $$ begin raise exception 'fixture receipt rollback';end $$`;
		await sql`create trigger reject_fixture_receipt before update on platform.external_service_queries for each row execute function reject_fixture_receipt()`;
		const accepted = discover();
		await vi.waitFor(async () => {
			const [row] =
				await sql`select count(*)::int as n from platform.external_service_queries where receipt is null`;
			expect(row?.n).toBe(1);
		});
		await expect(worker()).rejects.toThrow();
		expect((await command(2, "enable")).status).toBe(200);
		await sql`drop trigger reject_fixture_receipt on platform.external_service_queries`;
		await worker();
		expect(await (await accepted).json()).toMatchObject({
			revision: 1,
			discovery: { items: [{ ref: "a" }] },
		});

		await store.close();
		store = new ExternalServiceStore(db.databaseUrl);
		app = assemble();
		timer = start();
		expect(await (await discover()).json()).toMatchObject({
			revision: 2,
			discovery: { subjectId: "employee", items: [{ ref: "b" }] },
		});
		expect(
			a.calls.filter((p) => p === "/v1/model-authorizations"),
		).toHaveLength(4);
		expect(
			b.calls.filter((p) => p === "/v1/model-authorizations"),
		).toHaveLength(1);
		b.foreign(true);
		expect((await discover()).status).toBe(503);
		expect(
			(
				await call(
					"/api/v2/me/external-service-authorizations",
					{ id: "relay", subjectId: "other-user" },
					false,
				)
			).status,
		).toBe(400);
		expect((await command(2, "disable")).status).toBe(200);
		expect((await discover()).status).toBe(409);
		const view = await (await call(path)).text();
		expect(view).toContain("external_service.access");
		expect(view).not.toContain(a.credential);
		expect(view).not.toContain(b.credential);
	} finally {
		clearInterval(timer);
		await pending;
		await Promise.all([a.close(), b.close(), store.close(), sql.end()]);
		await db.stop();
	}
}, 120000);

it.each([
	...['fixture-"quoted-credential', "fixture-\\escaped-credential"].flatMap(
		(credential) =>
			(["ref", "displayName"] as const).map((field) => ({ credential, field })),
	),
	{ credential: "model-authorization", field: "manifest" as const },
])(
	"rejects credential echo in $field before persisting a Worker receipt",
	async ({ credential, field }) => {
		const db = await startPostgresTestDatabase(
			"external-service-credential-echo",
		);
		const store = new ExternalServiceStore(db.databaseUrl);
		const sql = openPostgresTestClient(db);
		const endpoint = await provider("echo", {
			credential,
			...(field === "manifest" ? {} : { echo: field }),
		});
		try {
			await migratePlatformDatabase({ databaseUrl: db.databaseUrl });
			const actor = { actorId: "employee", traceId: "credential-echo" };
			await store.candidate(
				"relay",
				0,
				endpoint.origin,
				(revision) =>
					encryptor.encrypt({
						schemaVersion: 1,
						ownerType: "platform",
						ownerId: "relay",
						agentId: "relay",
						name: "adapter-credential",
						secretId: createHash("sha256")
							.update(endpoint.origin)
							.digest("hex"),
						secretVersion: revision,
						configRevision: revision,
						plaintext: credential,
						occurredAt: new Date().toISOString(),
					}),
				actor,
				"echo-endpoint",
			);
			await store.tested("relay", 1, true, actor);
			await store.change("relay", 1, "enable", actor);
			await sql`insert into platform.external_service_queries(operation_id,instance_id,revision,actor_id,action,expires_at)
			values ('echo','relay',1,'employee',${field === "manifest" ? "test" : "discover"},clock_timestamp()+interval '15 seconds')`;
			const worker = createExternalServiceProbe(
				store,
				decryptor,
				(input, init) => {
					const url = new URL(String(input));
					expect(url.origin).toBe(endpoint.origin);
					return fetch(new URL(url.pathname, endpoint.local), init);
				},
			);
			await worker();
			expect(endpoint.calls).toContain(
				field === "manifest"
					? "/.well-known/agent-infra-adapter"
					: "/v1/model-authorizations",
			);
			const [result] = await sql<
				{ receipt: unknown }[]
			>`select receipt from platform.external_service_queries where operation_id='echo'`;
			expect(result?.receipt).toEqual({ failed: true });
		} finally {
			await Promise.all([endpoint.close(), store.close(), sql.end()]);
			await db.stop();
		}
	},
	120000,
);
