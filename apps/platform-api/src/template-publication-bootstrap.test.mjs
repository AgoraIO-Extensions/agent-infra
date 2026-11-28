import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createTemplatePublicationServiceTransportV1 } from "@agent-infra/platform-core";
import {
	migratePlatformDatabase,
	PostgresLdapSessionStoreV1,
} from "@agent-infra/platform-store";
import { expect, it } from "vitest";
import { createBootstrapPublicationRoutes } from "../../../deploy/ack/chart/files/template-publication-bootstrap.mjs";
import { startPostgresTestDatabase } from "../../../packages/platform-store/src/postgres-test.ts";

it("prepares independent bootstrap publications through a native browser session and only permits signed service status", async () => {
	const builtRoot = process.env.AGENT_INFRA_BOOTSTRAP_TEST_RELEASE_ROOT;
	const api = builtRoot
		? await import(
				/* @vite-ignore */ pathToFileURL(
					join(builtRoot, "apps/platform-api/dist/index.mjs"),
				).href
			)
		: await import("./index.ts");
	const db = await startPostgresTestDatabase("template-publication-bootstrap");
	const sessions = new PostgresLdapSessionStoreV1(db.databaseUrl);
	const origin = "https://control.example.test";
	let disabled = false;
	const admin = {
		uid: "bootstrap-fixture",
		userId: randomUUID(),
		email: "fixture@example.test",
		displayName: "Fixture",
		accountStatus: "active",
		roles: ["system_admin"],
		authorizationRevision: "fixture-v1",
	};
	const browser = api.createBrowserSessionAdapter({
		publicOrigin: origin,
		sessions,
		directory: {
			current: async () => admin,
			currentByUserId: async (id) => (id === admin.userId ? admin : null),
			userIdForUid: async () => admin.userId,
		},
		isPlatformDisabled: async () => disabled,
		organizationIds: async () => ["fixture-org"],
	});
	const ids = { pi: randomUUID(), codex: randomUUID() };
	const rollout = Object.fromEntries(
		Object.entries(ids).map(([templateId, publicationId]) => {
			const binding = {
				schemaVersion: 1,
				templateId,
				publicationId,
				deploymentRef: "fixture-install",
				catalogRevision: "catalog-v2",
				targetImageDigest: "sha256:" + "a".repeat(64),
				validationRef: "validation-v2",
				servicePrincipalRef: "publisher",
				authorizationRevision: "approval-v2",
				expiresAt: new Date(Date.now() + 120_000).toISOString(),
				expectedPreviousPublicationId: null,
				operatorIds: [admin.userId],
			};
			return [
				publicationId,
				{
					binding,
					material: {
						publicationId,
						deploymentRef: binding.deploymentRef,
						principalRef: binding.servicePrincipalRef,
						issuer: "fixture",
						keyVersion: "1",
						key: randomBytes(32),
					},
				},
			];
		}),
	);
	const app = createBootstrapPublicationRoutes({
		ids,
		assembly: {
			databaseUrl: db.databaseUrl,
			identity: browser.identityAdapter,
			files: { resolveActor: browser.resolveCurrentIdentity },
		},
		configuration: {
			loadBinding: async (id) => rollout[id].binding,
			serviceAuthentication: { currentKey: async (id) => rollout[id].material },
		},
		createApp: api.createAutomaticTemplatePublicationAppV1,
	});
	try {
		await migratePlatformDatabase({ databaseUrl: db.databaseUrl });
		const session = await browser.issueSession(admin);
		expect(session.status).toBe(204);
		const cookie = session.headers.get("set-cookie").split(";")[0];
		const path = (id) =>
			`${origin}/internal/ops/standard-template-releases/${id}/`;
		const post = (id, action, headers = {}) =>
			app.app.fetch(
				new Request(path(id) + action, {
					method: "POST",
					headers: { "content-type": "application/json", origin, ...headers },
					body: '{"schemaVersion":1}',
				}),
			);
		const signed = (id, key) =>
			createTemplatePublicationServiceTransportV1({
				currentKey: async () => ({ ...rollout[id].material, key }),
				fetch: (request) => app.app.fetch(request),
			}).request(new Request(path(id) + "status-automatic"));
		for (const id of Object.values(ids)) {
			expect((await post(id, "prepare-automatic")).status).toBe(401);
			expect((await post(id, "prepare-automatic", { cookie })).status).toBe(
				202,
			);
			expect((await signed(id, rollout[id].material.key)).status).toBe(200);
			const other = id === ids.pi ? ids.codex : ids.pi;
			expect((await signed(id, rollout[other].material.key)).status).toBe(403);
			for (const action of [
				"activate-automatic",
				"run-automatic",
				"worker-ready",
				"revoke-automatic",
			]) {
				expect((await post(id, action, { cookie })).status).toBe(403);
			}
		}
		expect(
			(await post(randomUUID(), "prepare-automatic", { cookie })).status,
		).toBe(404);
		disabled = true;
		expect((await signed(ids.pi, rollout[ids.pi].material.key)).status).toBe(
			403,
		);
	} finally {
		await app.close();
		await sessions.close();
		await db.stop();
	}
}, 120_000);
