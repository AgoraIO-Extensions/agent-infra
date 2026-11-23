import { createHash } from "node:crypto";
import { isIP } from "node:net";
import {
	ExternalServiceCandidate,
	ExternalServiceCommand,
	ExternalServiceDiscoveryRequest,
	ExternalServiceReceipt,
	ExternalServiceView,
} from "@agent-infra/contracts/pilot";
import {
	ExternalServiceConflict,
	type ExternalServiceStore,
} from "@agent-infra/platform-store";
import type { SecretEncryptorV1 } from "@agent-infra/secret-store";
import type { Context, Hono } from "hono";
import { HttpProtocolError, parseJson, requestMetadata } from "./common.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";

export interface ExternalServiceAdmin {
	store: ExternalServiceStore;
	encryptor: SecretEncryptorV1;
	worker?: { baseUrl: string; serviceToken: string; fetch?: typeof fetch };
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
		if (!admin.worker) throw new Error();
		const base = new URL(admin.worker.baseUrl);
		if (
			base.protocol !== "http:" ||
			base.username ||
			base.password ||
			base.pathname !== "/" ||
			base.search ||
			base.hash
		)
			throw new Error();
		const response = await (admin.worker.fetch ?? fetch)(
			new URL("/internal/worker/v1/external-service", base),
			{
				method: "POST",
				redirect: "error",
				headers: {
					authorization: `Bearer ${admin.worker.serviceToken}`,
					"content-type": "application/json",
					"x-trace-id": actor.traceId,
				},
				body: JSON.stringify({ actorId: actor.actorId, command: value }),
				signal: AbortSignal.any([signal, AbortSignal.timeout(7000)]),
			},
		);
		if (!response.ok) throw new Error();
		const receipt = ExternalServiceReceipt.parse(await response.json());
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
	async function authorize(c: Context) {
		c.header("Cache-Control", "no-store");
		const { traceId } = requestMetadata(c.req.raw);
		if (c.req.header("authorization"))
			throw new HttpProtocolError("FORBIDDEN", traceId);
		const user = await resolveIdentity(identity, c.req.raw, traceId);
		const actor = { actorId: user.userId, traceId };
		if (!user.roles.includes("system_admin")) {
			await admin.store.denied(actor);
			throw new HttpProtocolError("FORBIDDEN", traceId);
		}
		return actor;
	}
	app.post("/api/v2/me/external-service-authorizations", async (c) => {
		c.header("Cache-Control", "no-store");
		const { traceId } = requestMetadata(c.req.raw);
		if (c.req.header("authorization"))
			throw new HttpProtocolError("FORBIDDEN", traceId);
		const user = await resolveIdentity(identity, c.req.raw, traceId);
		const { value } = await parseJson(
			c.req.raw,
			ExternalServiceDiscoveryRequest,
			traceId,
		);
		const version = await admin.store.activeRevision(value.id);
		if (version === null) throw new HttpProtocolError("CONFLICT", traceId);
		try {
			return c.json(
				await sendToWorker(
					{ action: "discover", id: value.id, revision: version },
					{ actorId: user.userId, traceId },
					c.req.raw.signal,
				),
			);
		} catch {
			throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
		}
	});
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
		const url = new URL(value.url);
		if (
			url.protocol !== "https:" ||
			url.origin !== value.url.replace(/\/$/, "") ||
			isIP(url.hostname) ||
			url.hostname.startsWith("[") ||
			url.hostname === "localhost" ||
			url.hostname.endsWith(".localhost")
		)
			throw new HttpProtocolError("INVALID_REQUEST", actor.traceId);
		try {
			const revision = await admin.store.candidate(
				value.id,
				value.expectedRevision,
				url.origin,
				(version) =>
					admin.encryptor.encrypt({
						schemaVersion: 1,
						ownerType: "platform",
						ownerId: value.id,
						agentId: value.id,
						name: "adapter-credential",
						secretId: createHash("sha256").update(url.origin).digest("hex"),
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
				await admin.store.tested(value.id, value.revision, true, actor);
			return c.json(receipt);
		} catch (error) {
			if (error instanceof ExternalServiceConflict)
				throw new HttpProtocolError("CONFLICT", actor.traceId);
			if (error instanceof HttpProtocolError) throw error;
			throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", actor.traceId);
		}
	});
}
