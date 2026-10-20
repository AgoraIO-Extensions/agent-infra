import {
	FileLimitDeclarationErrorV1,
	type FileLimitDeclarationRecordV1,
	type FileLimitDeclarationStoreV1,
	type FileLimitDeclarationSubjectV1,
	readFileLimitDeclarationV1,
	writeFileLimitDeclarationV1,
} from "@agent-infra/platform-core";
import { expect, it } from "vitest";

import { createPlatformHealthApp } from "../app.js";
import {
	type FileLimitRoutesDependenciesV1,
	registerFileLimitRoutesV2,
} from "./file-limit-routes.js";
import type { IdentityContext } from "./identity.js";

function subjectKey(subject: FileLimitDeclarationSubjectV1): string {
	return subject.scope === "channel"
		? `${subject.scope}\0${subject.agentId}\0${subject.channelId}`
		: subject.scope === "agent"
			? `${subject.scope}\0${subject.agentId}\0`
			: "deployment\0\0";
}

function memoryStore() {
	type StoredRecord = FileLimitDeclarationRecordV1 & {
		readonly idempotencyKey: string;
		readonly requestDigest: string;
	};
	const records = new Map<string, StoredRecord>();
	let revision = 0;
	const store = {
		async read(subject: FileLimitDeclarationSubjectV1) {
			return records.get(subjectKey(subject)) ?? null;
		},
		async readAgentConfigurationRevision() {
			return 4;
		},
		async write(input) {
			const key = subjectKey(input.subject);
			const existing = records.get(key);
			if (
				existing &&
				existing.idempotencyKey === input.idempotencyKey &&
				existing.requestDigest === input.requestDigest
			)
				return existing;
			const expected = existing?.revision ?? null;
			if (input.expectedRevision !== expected)
				throw new FileLimitDeclarationErrorV1("conflict");
			revision += 1;
			const record: StoredRecord = {
				scope: input.subject.scope,
				agentId:
					input.subject.scope === "deployment" ? "" : input.subject.agentId,
				channelId:
					input.subject.scope === "channel" ? input.subject.channelId : null,
				revision,
				expiresAt: input.declaration.expiresAt,
				mediaTypes: input.declaration.mediaTypes,
				maxBytes: input.declaration.maxBytes,
				updatedAt: input.now.toISOString(),
				updatedBy: input.actorId,
				idempotencyKey: input.idempotencyKey,
				requestDigest: input.requestDigest,
			};
			records.set(key, record);
			return record;
		},
	} satisfies FileLimitDeclarationStoreV1;
	return { store, records };
}

const employee = (userId: string): IdentityContext => ({
	schemaVersion: 1,
	userId,
	displayName: userId,
	accountStatus: "active",
	organizationIds: ["org"],
	roles: ["employee"],
	authorizationRevision: "auth-1",
});
const administrator = (userId: string): IdentityContext => ({
	...employee(userId),
	roles: ["employee", "system_admin"],
});

const future = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

function createApp(
	identity: IdentityContext,
	authorize: (
		identity: IdentityContext,
		subject: FileLimitDeclarationSubjectV1,
	) => boolean,
) {
	const { store, records } = memoryStore();
	const app = createPlatformHealthApp();
	const dependencies: FileLimitRoutesDependenciesV1 = {
		identity: {
			resolve: async () => identity,
			hydrateUsers: async () => [],
		},
		read: (actor, subject) =>
			readFileLimitDeclarationV1({
				store,
				subject,
				authorize: async () => authorize(actor, subject),
			}),
		write: (actor, subject, request) =>
			writeFileLimitDeclarationV1({
				store,
				subject,
				declaration: request.declaration,
				expectedRevision: request.expectedRevision,
				idempotencyKey: request.idempotencyKey,
				actorId: actor.userId,
				now: new Date(),
				authorize: async () => authorize(actor, subject),
			}),
	};
	registerFileLimitRoutesV2(app, dependencies);
	return { app, records };
}

const declaration = (overrides: Record<string, unknown> = {}) => ({
	expiresAt: future(),
	mediaTypes: ["text/plain"],
	maxBytes: 4096,
	...overrides,
});

const ownedAgents = new Set(["agent-1"]);
const ownerAuthorize = (
	identity: IdentityContext,
	subject: FileLimitDeclarationSubjectV1,
) =>
	subject.scope === "deployment"
		? identity.roles.includes("system_admin")
		: identity.roles.includes("system_admin") ||
			(identity.userId === "owner" && ownedAgents.has(subject.agentId));

it("lets the Agent Owner create and replace an Agent declaration", async () => {
	const { app } = createApp(employee("owner"), ownerAuthorize);
	const url = "/api/v2/agents/agent-1/file-limits";
	const created = await app.request(url, {
		method: "PUT",
		headers: {
			"content-type": "application/json",
			"Idempotency-Key": "Command.Aa-01",
		},
		body: JSON.stringify({
			schemaVersion: 1,
			declaration: declaration(),
			expectedRevision: null,
		}),
	});
	expect(created.status).toBe(200);
	expect(await created.json()).toMatchObject({
		schemaVersion: 1,
		declaration: { schemaVersion: 1, scope: "agent", revision: 1 },
	});
	const read = await app.request(url);
	expect(read.status).toBe(200);
	expect(await read.json()).toMatchObject({
		declaration: { scope: "agent", revision: 1 },
	});
	const replaced = await app.request(url, {
		method: "PUT",
		headers: {
			"content-type": "application/json",
			"Idempotency-Key": "Command.Aa-02",
		},
		body: JSON.stringify({
			schemaVersion: 1,
			declaration: declaration({ maxBytes: 1024 }),
			expectedRevision: 1,
		}),
	});
	expect(replaced.status).toBe(200);
	expect(await replaced.json()).toMatchObject({
		declaration: { revision: 2, maxBytes: 1024 },
	});
});

it("rejects a non-owner before the declaration store sees the write", async () => {
	const { app, records } = createApp(employee("mallory"), ownerAuthorize);
	const response = await app.request("/api/v2/agents/agent-1/file-limits", {
		method: "PUT",
		headers: {
			"content-type": "application/json",
			"Idempotency-Key": "Command.Aa-01",
		},
		body: JSON.stringify({
			schemaVersion: 1,
			declaration: declaration(),
			expectedRevision: null,
		}),
	});
	expect(response.status).toBe(403);
	expect(records.size).toBe(0);
	expect((await app.request("/api/v2/agents/agent-1/file-limits")).status).toBe(
		403,
	);
});

it("rejects a revoked administrator for the deployment declaration", async () => {
	const notAnAdminAnymore = employee("admin");
	const { app } = createApp(notAnAdminAnymore, ownerAuthorize);
	const response = await app.request("/api/v2/admin/deployment/file-limits", {
		method: "PUT",
		headers: {
			"content-type": "application/json",
			"Idempotency-Key": "Command.Aa-01",
		},
		body: JSON.stringify({
			schemaVersion: 1,
			declaration: declaration(),
			expectedRevision: null,
		}),
	});
	expect(response.status).toBe(403);
});

it("lets a system administrator write the deployment declaration", async () => {
	const { app } = createApp(administrator("admin"), ownerAuthorize);
	const response = await app.request("/api/v2/admin/deployment/file-limits", {
		method: "PUT",
		headers: {
			"content-type": "application/json",
			"Idempotency-Key": "Command.Aa-01",
		},
		body: JSON.stringify({
			schemaVersion: 1,
			declaration: declaration({ mediaTypes: ["text/plain", "image/png"] }),
			expectedRevision: null,
		}),
	});
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({
		declaration: {
			scope: "deployment",
			revision: 1,
			mediaTypes: ["image/png", "text/plain"],
		},
	});
});

it("scopes Channel declarations to the Agent in the path", async () => {
	const { app } = createApp(employee("owner"), ownerAuthorize);
	const response = await app.request(
		"/api/v2/agents/agent-1/channels/wecom_bot:bot-1/file-limits",
		{
			method: "PUT",
			headers: {
				"content-type": "application/json",
				"Idempotency-Key": "Command.Aa-01",
			},
			body: JSON.stringify({
				schemaVersion: 1,
				declaration: declaration(),
				expectedRevision: null,
			}),
		},
	);
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({
		declaration: { scope: "channel", revision: 1 },
	});
	expect(
		(
			await app.request(
				"/api/v2/agents/agent-2/channels/wecom_bot:bot-1/file-limits",
			)
		).status,
	).toBe(403);
});

it("rejects expired, malformed and stale declaration writes", async () => {
	const { app } = createApp(employee("owner"), ownerAuthorize);
	const url = "/api/v2/agents/agent-1/file-limits";
	const send = (body: unknown, key = "Command.Aa-01") =>
		app.request(url, {
			method: "PUT",
			headers: {
				"content-type": "application/json",
				"Idempotency-Key": key,
			},
			body: JSON.stringify(body),
		});
	expect(
		(
			await send({
				schemaVersion: 1,
				declaration: declaration({
					expiresAt: new Date(Date.now() - 1000).toISOString(),
				}),
				expectedRevision: null,
			})
		).status,
	).toBe(400);
	expect(
		(
			await send({
				schemaVersion: 1,
				declaration: declaration({ mediaTypes: ["not-a-media-type"] }),
				expectedRevision: null,
			})
		).status,
	).toBe(400);
	expect(
		(
			await send({
				schemaVersion: 1,
				declaration: declaration({ maxBytes: 0 }),
				expectedRevision: null,
			})
		).status,
	).toBe(400);
	expect(
		(
			await send({
				schemaVersion: 1,
				declaration: declaration(),
				expectedRevision: null,
			})
		).status,
	).toBe(200);
	expect(
		(
			await send(
				{
					schemaVersion: 1,
					declaration: declaration(),
					expectedRevision: null,
				},
				"Command.Aa-02",
			)
		).status,
	).toBe(409);
	expect(
		(
			await send(
				{
					schemaVersion: 1,
					declaration: declaration(),
					expectedRevision: 2,
				},
				"Command.Aa-03",
			)
		).status,
	).toBe(409);
});

it("requires an Idempotency-Key and rejects browser Authorization headers", async () => {
	const { app } = createApp(employee("owner"), ownerAuthorize);
	const url = "/api/v2/agents/agent-1/file-limits";
	expect(
		(
			await app.request(url, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					schemaVersion: 1,
					declaration: declaration(),
					expectedRevision: null,
				}),
			})
		).status,
	).toBe(400);
	expect(
		(
			await app.request(url, {
				method: "PUT",
				headers: {
					"content-type": "application/json",
					"Idempotency-Key": "Command.Aa-01",
					Authorization: "Bearer synthetic",
				},
				body: JSON.stringify({
					schemaVersion: 1,
					declaration: declaration(),
					expectedRevision: null,
				}),
			})
		).status,
	).toBe(401);
});
