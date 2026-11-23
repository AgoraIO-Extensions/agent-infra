import { createHash } from "node:crypto";
import { isIP } from "node:net";
import {
	ExternalAuthorizations,
	ExternalServiceCommand,
	ExternalServiceManifest,
} from "@agent-infra/contracts/pilot";
import { validatePlatformSecretRecordV1 } from "@agent-infra/contracts/workload";
import type { SecretActivationDecryptorPortV1 } from "@agent-infra/platform-core";
import type { ExternalServiceStore } from "@agent-infra/platform-store";

export function createExternalServiceProbe(
	store: ExternalServiceStore,
	decryptor: SecretActivationDecryptorPortV1,
	transport: typeof fetch = fetch,
) {
	return async (request: Request) => {
		const body = await request.json().catch(() => null);
		if (
			!body ||
			typeof body !== "object" ||
			!("command" in body) ||
			!("actorId" in body)
		)
			return new Response(null, { status: 400 });
		const command = ExternalServiceCommand.safeParse(body?.command);
		if (
			!command.success ||
			typeof body.actorId !== "string" ||
			!body.actorId.length ||
			body.actorId.length > 256
		)
			return new Response(null, { status: 400 });
		const { id, revision, action } = command.data;
		if (action !== "test" && action !== "discover")
			return new Response(null, { status: 400 });
		const version =
			action === "test"
				? await store.version(id, revision)
				: await store.active(id);
		if (!version || version.revision !== revision)
			return new Response(null, { status: 409 });
		try {
			const url = new URL(version.url);
			const signal = AbortSignal.any([
				request.signal,
				AbortSignal.timeout(5000),
			]);
			if (
				url.protocol !== "https:" ||
				url.origin !== version.url ||
				isIP(url.hostname) ||
				url.hostname.startsWith("[") ||
				!url.hostname.includes(".") ||
				url.hostname.endsWith(".localhost")
			)
				throw new Error();
			const record = validatePlatformSecretRecordV1(version.credential);
			const expected = createHash("sha256").update(version.url).digest("hex");
			if (
				record.ownerType !== "platform" ||
				record.ownerId !== id ||
				record.agentId !== id ||
				record.secretVersion !== revision ||
				record.configRevision !== revision ||
				record.secretId !== expected ||
				record.name !== "adapter-credential"
			)
				throw new Error();
			const decoded = await decryptor.decrypt({
				encryptedRecord: record,
				traceId: request.headers.get("x-trace-id") ?? "external-service",
			});
			if (decoded.outcome !== "decrypted") throw new Error();
			try {
				const credential = Buffer.from(decoded.plaintext).toString("utf8");
				const path =
					action === "test"
						? "/.well-known/agent-infra-adapter"
						: "/v1/model-authorizations";
				const response = await transport(new URL(path, url), {
					method: action === "test" ? "GET" : "POST",
					headers: {
						authorization: `Bearer ${credential}`,
						"content-type": "application/json",
						accept: "application/json",
					},
					...(action === "discover"
						? {
								body: JSON.stringify({
									schemaVersion: 1,
									subjectId: body.actorId,
								}),
							}
						: {}),
					redirect: "error",
					credentials: "omit",
					signal,
				});
				if (
					!response.ok ||
					response.redirected ||
					!response.body ||
					!/^application\/json\b/i.test(
						response.headers.get("content-type") ?? "",
					)
				) {
					await response.body?.cancel();
					throw new Error();
				}
				const reader = response.body.getReader();
				const chunks: Uint8Array[] = [];
				let size = 0;
				try {
					while (true) {
						const part = await reader.read();
						if (part.done) break;
						size += part.value.length;
						if (size > 65536) throw new Error();
						chunks.push(part.value);
					}
				} finally {
					await reader.cancel().catch(() => {});
				}
				const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				if (action === "test") {
					const manifest = ExternalServiceManifest.parse(data);
					if (manifest.instanceId !== id) throw new Error();
					return Response.json({ revision, manifest });
				}
				const discovery = ExternalAuthorizations.parse(data);
				if (
					discovery.instanceId !== id ||
					discovery.subjectId !== body.actorId ||
					JSON.stringify(discovery).includes(credential)
				)
					throw new Error();
				return Response.json({ revision, discovery });
			} finally {
				decoded.plaintext.fill(0);
			}
		} catch {
			return new Response(null, { status: 502 });
		}
	};
}
