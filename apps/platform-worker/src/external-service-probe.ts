import { createHash } from "node:crypto";

import {
	ExternalAuthorizations,
	ExternalServiceManifest,
	externalServiceOrigin,
} from "@agent-infra/contracts/pilot";
import { validatePlatformSecretRecordV1 } from "@agent-infra/contracts/workload";
import type { SecretActivationDecryptorPortV1 } from "@agent-infra/platform-core";
import type { ExternalServiceStore } from "@agent-infra/platform-store";

export function createExternalServiceProbe(
	store: ExternalServiceStore,
	decryptor: SecretActivationDecryptorPortV1,
	transport: typeof fetch = fetch,
) {
	return () =>
		store.processQuery(async ({ id, revision, action, actorId }, version) => {
			const signal = AbortSignal.timeout(5000);
			const url = new URL(externalServiceOrigin(version.url));
			const manifestPath = new URL("/.well-known/agent-infra-adapter", url);
			const inspect = (data: unknown) => {
				const manifest = ExternalServiceManifest.parse(data);
				if (
					manifest.instanceId !== id ||
					!manifest.capabilities.includes("model-authorization")
				)
					throw new Error("Incompatible model authorization adapter");
				return manifest;
			};
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
				traceId: "external-service",
			});
			if (decoded.outcome !== "decrypted") throw new Error();
			try {
				const credential = Buffer.from(decoded.plaintext).toString("utf8");
				const manifest = inspect(
					await readJson(
						await transport(manifestPath, {
							headers: {
								authorization: `Bearer ${credential}`,
								accept: "application/json",
							},
							signal,
							redirect: "error",
							credentials: "omit",
						}),
					),
				);
				if (
					[manifest.instanceId, ...manifest.capabilities].some((value) =>
						value.includes(credential),
					)
				)
					throw new Error();
				if (action === "test") return { revision, manifest };
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
									subjectId: actorId,
								}),
							}
						: {}),
					redirect: "error",
					credentials: "omit",
					signal,
				});
				const data = await readJson(response);
				const discovery = ExternalAuthorizations.parse(data);
				if (
					discovery.instanceId !== id ||
					discovery.subjectId !== actorId ||
					[
						discovery.instanceId,
						discovery.subjectId,
						...discovery.items.flatMap((item) => [item.ref, item.displayName]),
					].some((value) => value.includes(credential))
				)
					throw new Error();
				return { revision, discovery };
			} finally {
				decoded.plaintext.fill(0);
			}
		});
}

async function readJson(response: Response): Promise<unknown> {
	if (
		!response.ok ||
		response.redirected ||
		!response.body ||
		!/^application\/json\b/i.test(response.headers.get("content-type") ?? "")
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
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
