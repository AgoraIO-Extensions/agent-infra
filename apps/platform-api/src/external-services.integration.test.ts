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
import { expect, it } from "vitest";
import { startPostgresTestDatabase } from "../../../packages/platform-store/src/postgres-test.js";
import { createExternalServiceProbe } from "../../platform-worker/src/external-service-probe.js";
import { createWorkerSavedKeyCandidatesApp } from "../../platform-worker/src/saved-key-candidates-service.js";
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
async function provider(name: string) {
	const credential = randomUUID();
	const calls: string[] = [];
	let valid = true;
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
				subjectId,
				items: [{ ref: name, displayName: name }],
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
	const a = await provider("a");
	const b = await provider("b");
	let store = new ExternalServiceStore(db.databaseUrl);
	const serviceToken = randomUUID();
	function assemble() {
		const worker = createWorkerSavedKeyCandidatesApp({
			serviceToken,
			reader: {
				read: async () => {
					throw Error();
				},
			},
			externalService: createExternalServiceProbe(
				store,
				decryptor,
				(input, init) => {
					const url = new URL(String(input));
					const target = [a, b].find((p) => p.origin === url.origin);
					if (!target) throw Error("unexpected destination");
					return fetch(new URL(url.pathname, target.local), init);
				},
			),
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
				worker: {
					baseUrl: "http://worker",
					serviceToken,
					fetch: (input, init) => worker.fetch(new Request(input, init)),
				},
			},
		);
		return app;
	}
	let app = assemble();
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
		});
	const discover = () =>
		call("/api/v2/me/external-service-authorizations", { id: "relay" }, false);
	try {
		await migratePlatformDatabase({ databaseUrl: db.databaseUrl });
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
		expect((await command(2, "enable")).status).toBe(200);
		await store.close();
		store = new ExternalServiceStore(db.databaseUrl);
		app = assemble();
		expect(await (await discover()).json()).toMatchObject({
			revision: 2,
			discovery: { subjectId: "employee", items: [{ ref: "b" }] },
		});
		expect(
			a.calls.filter((p) => p === "/v1/model-authorizations"),
		).toHaveLength(2);
		expect(
			b.calls.filter((p) => p === "/v1/model-authorizations"),
		).toHaveLength(1);
		expect((await command(2, "disable")).status).toBe(200);
		expect((await discover()).status).toBe(409);
		const view = await (await call(path)).text();
		expect(view).toContain("external_service.access");
		expect(view).not.toContain(a.credential);
		expect(view).not.toContain(b.credential);
	} finally {
		await Promise.all([a.close(), b.close(), store.close()]);
		await db.stop();
	}
}, 120000);
