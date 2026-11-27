import { createHash } from "node:crypto";

import {
	ExternalServiceCandidate,
	ExternalServiceCommand,
	ExternalServiceDiscoveryRequest,
	type ExternalServiceReceipt,
	ExternalServiceView,
	externalServiceOrigin,
	PersonalRuntimeBindingUpdate,
} from "@agent-infra/contracts/pilot";
import {
	ExternalServiceConflict,
	type ExternalServiceStore,
	PersonalRuntimeForbidden,
} from "@agent-infra/platform-store";
import type { SecretEncryptorV1 } from "@agent-infra/secret-store";
import type { Context, Hono } from "hono";
import { HttpProtocolError, parseJson, requestMetadata } from "./common.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";

export interface ExternalServiceAdmin {
	store: ExternalServiceStore;
	encryptor: SecretEncryptorV1;
}
export function registerExternalServiceRoutes(
	app: Hono,
	identity: IdentityAdapter,
	admin: ExternalServiceAdmin,
) {
	const path = "/api/v2/admin/external-services";
	async function sendToWorker(
		value: ReturnType<typeof ExternalServiceCommand.parse>,
		actor: { actorId: string; traceId: string },
		signal: AbortSignal,
	) {
		const receipt = await admin.store.query(value, actor, signal);
		if (
			receipt.revision !== value.revision ||
			(value.action === "test"
				? receipt.manifest?.instanceId !== value.id
				: receipt.discovery?.instanceId !== value.id ||
					receipt.discovery.subjectId !== actor.actorId)
		)
			throw new Error();
		return receipt;
	}
	async function sessionUser(c: Context) {
		c.header("Cache-Control", "no-store");
		const { traceId } = requestMetadata(c.req.raw);
		if (c.req.header("authorization"))
			throw new HttpProtocolError("FORBIDDEN", traceId);
		return {
			user: await resolveIdentity(identity, c.req.raw, traceId),
			traceId,
		};
	}
	async function authorize(c: Context) {
		const { user, traceId } = await sessionUser(c);
		const actor = { actorId: user.userId, traceId };
		if (!user.roles.includes("system_admin")) {
			await admin.store.denied(actor);
			throw new HttpProtocolError("FORBIDDEN", traceId);
		}
		return actor;
	}
	async function discover(c: Context, action: "targets" | "discover") {
		const { user, traceId } = await sessionUser(c);
		const { value } = await parseJson(
			c.req.raw,
			ExternalServiceDiscoveryRequest,
			traceId,
		);
		const version = await admin.store.activeRevision(value.id);
		if (version === null) throw new HttpProtocolError("CONFLICT", traceId);
		try {
			const actor = { actorId: user.userId, traceId };
			if (action === "targets")
				return c.json(
					await admin.store.runtimeTargets(
						value.id,
						version,
						actor,
						c.req.raw.signal,
					),
				);
			return c.json(
				await sendToWorker(
					{ action, id: value.id, revision: version },
					actor,
					c.req.raw.signal,
				),
			);
		} catch {
			throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
		}
	}
	app.post("/api/v2/me/external-service-authorizations", (c) =>
		discover(c, "discover"),
	);
	app.post("/api/v2/me/external-runtime-targets", (c) =>
		discover(c, "targets"),
	);
	app.on(
		["GET", "PUT"],
		"/api/v2/agents/:agentId/personal-runtime",
		async (c) => {
			const { user, traceId } = await sessionUser(c);
			const actor = { actorId: user.userId, traceId };
			const agentId = c.req.param("agentId");
			if (!agentId) throw new HttpProtocolError("INVALID_REQUEST", traceId);
			try {
				if (c.req.method === "GET")
					return c.json(await admin.store.personalBinding(agentId, actor));
				const { value } = await parseJson(
					c.req.raw,
					PersonalRuntimeBindingUpdate,
					traceId,
				);
				return c.json(
					await admin.store.savePersonalBinding(
						agentId,
						value,
						actor,
						c.req.raw.signal,
					),
				);
			} catch (error) {
				if (error instanceof HttpProtocolError) throw error;
				if (error instanceof PersonalRuntimeForbidden)
					throw new HttpProtocolError("FORBIDDEN", traceId);
				if (error instanceof ExternalServiceConflict)
					throw new HttpProtocolError("CONFLICT", traceId);
				throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
			}
		},
	);
	app.get(path, async (c) => {
		await authorize(c);
		return c.json(ExternalServiceView.parse(await admin.store.view()));
	});
	app.post(path, async (c) => {
		const actor = await authorize(c);
		const { value } = await parseJson(
			c.req.raw,
			ExternalServiceCandidate,
			actor.traceId,
		);
		let origin: string;
		try {
			origin = externalServiceOrigin(value.url);
		} catch {
			throw new HttpProtocolError("INVALID_REQUEST", actor.traceId);
		}
		try {
			const revision = await admin.store.candidate(
				value.id,
				value.expectedRevision,
				origin,
				(version) =>
					admin.encryptor.encrypt({
						schemaVersion: 1,
						ownerType: "platform",
						ownerId: value.id,
						agentId: value.id,
						name: "adapter-credential",
						secretId: createHash("sha256").update(origin).digest("hex"),
						secretVersion: version,
						configRevision: version,
						plaintext: value.credential,
						occurredAt: new Date().toISOString(),
					}),
				actor,
				value.modelEndpointId,
			);
			return c.json({ revision });
		} catch (error) {
			if (error instanceof ExternalServiceConflict)
				throw new HttpProtocolError("CONFLICT", actor.traceId);
			throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", actor.traceId);
		}
	});
	app.post(`${path}/commands`, async (c) => {
		const actor = await authorize(c);
		const { value } = await parseJson(
			c.req.raw,
			ExternalServiceCommand,
			actor.traceId,
		);
		try {
			if (value.action === "enable" || value.action === "disable") {
				await admin.store.change(value.id, value.revision, value.action, actor);
				return c.json({ revision: value.revision });
			}
			let receipt: ReturnType<typeof ExternalServiceReceipt.parse>;
			try {
				receipt = await sendToWorker(value, actor, c.req.raw.signal);
			} catch {
				if (value.action === "test")
					await admin.store.tested(value.id, value.revision, false, actor);
				throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", actor.traceId);
			}
			if (value.action === "test")
				await admin.store.tested(
					value.id,
					value.revision,
					true,
					actor,
					receipt.manifest?.capabilities.includes("discovery"),
				);
			return c.json(receipt);
		} catch (error) {
			if (error instanceof ExternalServiceConflict)
				throw new HttpProtocolError("CONFLICT", actor.traceId);
			if (error instanceof HttpProtocolError) throw error;
			throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", actor.traceId);
		}
	});
}
