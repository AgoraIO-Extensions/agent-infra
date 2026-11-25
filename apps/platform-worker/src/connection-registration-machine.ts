import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { dirname, isAbsolute, sep } from "node:path";
import { Readable } from "node:stream";
import {
	type ConnectionConsumerRegistrationIntentV1,
	connectionServiceCredentialSecretInputV1,
} from "@agent-infra/platform-core";
import { createSecretEncryptorV1 } from "@agent-infra/secret-store";
import {
	type ConnectionRegistrationHttpOptionsV1,
	createConnectionConsumerRegistrationHttpAdapterV2,
} from "./connection-registration-http.js";

export {
	createConnectionConsumerRegistrationHttpAdapterV1,
	createConnectionConsumerRegistrationHttpAdapterV2,
} from "./connection-registration-http.js";

const invalid = () => new Error("CONNECTION_REGISTRATION_MACHINE_UNAVAILABLE");
const component = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
function origin(value: string) {
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		url.origin !== value ||
		url.username ||
		url.password
	)
		throw invalid();
	return url.origin;
}

/** Native HTTPS dispatches each command once, including HTTP 421; never follows a redirect. */
export function createConnectionRegistrationMachineTransportV2(input: {
	publicOrigin: string;
	sourceNamespace: string;
	credentialFile: string;
	ca?: string;
}) {
	const targetOrigin = origin(input.publicOrigin);
	if (
		!component.test(input.sourceNamespace) ||
		!isAbsolute(input.credentialFile)
	)
		throw invalid();
	return async (request: Request): Promise<Response> => {
		request.signal.throwIfAborted();
		const target = new URL(request.url);
		const prefix = `/connection/internal/v2/platform-agent-consumer-registrations/${encodeURIComponent(input.sourceNamespace)}/`;
		const [agent, ...operation] = target.pathname
			.slice(prefix.length)
			.split("/");
		const suffix = operation.join("/");
		if (
			target.origin !== targetOrigin ||
			!target.pathname.startsWith(prefix) ||
			!agent ||
			!component.test(agent) ||
			target.search ||
			target.hash ||
			target.username ||
			target.password ||
			request.credentials !== "omit" ||
			request.redirect !== "error" ||
			!["GET", "POST", "DELETE"].includes(request.method) ||
			(request.method === "GET"
				? !(
						suffix === "" ||
						suffix === "owner-binding" ||
						/^operations\/(create|disable|delete)\/[a-f0-9]{64}$/.test(suffix)
					)
				: request.method === "POST"
					? !["", "disable"].includes(suffix)
					: suffix !== "") ||
			[...request.headers.keys()].some(
				(key) => !["accept", "content-type", "idempotency-key"].includes(key),
			)
		)
			throw invalid();
		const root = await realpath(dirname(input.credentialFile));
		const actual = await realpath(input.credentialFile);
		if (!actual.startsWith(root + sep)) throw invalid();
		const file = await open(
			actual,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		let token: string;
		try {
			const stat = await file.stat();
			if (
				!stat.isFile() ||
				stat.size > 256 ||
				stat.size < 1 ||
				stat.mode & 0o007
			)
				throw invalid();
			const bytes = Buffer.alloc(257);
			const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
			if (bytesRead > 256) throw invalid();
			token = bytes.subarray(0, bytesRead).toString("utf8").trim();
			if (!/^conn_platform_reg_[A-Za-z0-9_-]{43}$/.test(token)) throw invalid();
		} finally {
			await file.close();
		}
		const body = Buffer.from(await request.arrayBuffer());
		if (body.length > 8192 || (request.method === "GET" && body.length))
			throw invalid();
		request.signal.throwIfAborted();
		return new Promise<Response>((resolve, reject) => {
			const outgoing = httpsRequest(
				target,
				{
					method: request.method,
					rejectUnauthorized: true,
					headers: {
						...Object.fromEntries(request.headers),
						authorization: `Bearer ${token}`,
						...(body.length ? { "content-length": String(body.length) } : {}),
					},
					signal: request.signal,
					...(input.ca ? { ca: input.ca } : {}),
				},
				(incoming) => {
					const status = incoming.statusCode ?? 502;
					if (status < 200 || status > 599) {
						incoming.destroy();
						reject(invalid());
						return;
					}
					const headers = new Headers();
					for (const name of ["content-type", "cache-control"]) {
						const value = incoming.headers[name];
						if (typeof value === "string") headers.set(name, value);
					}
					if ([204, 205, 304].includes(status)) {
						incoming.resume();
						resolve(new Response(null, { status, headers }));
						return;
					}
					resolve(
						new Response(
							Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
							{ status, headers },
						),
					);
				},
			);
			outgoing.once("error", () => reject(invalid()));
			outgoing.end(body);
		});
	};
}

/** Independent current binding; never derives expected Owner values from a create receipt. */
export function createConnectionRegistrationOwnerBindingResolverV2(input: {
	publicOrigin: string;
	authenticatedRequest: NonNullable<
		ConnectionRegistrationHttpOptionsV1["authenticatedRequest"]
	>;
}): NonNullable<ConnectionRegistrationHttpOptionsV1["resolveOwnerBinding"]> {
	const targetOrigin = origin(input.publicOrigin);
	return async (
		intent: ConnectionConsumerRegistrationIntentV1,
		signal: AbortSignal,
	) => {
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		const cancel = () => {
			void reader?.cancel().catch(() => {});
		};
		try {
			signal.throwIfAborted();
			if (
				!component.test(intent.sourceNamespace) ||
				!component.test(intent.platformAgentId)
			)
				return undefined;
			const target = `${targetOrigin}/connection/internal/v2/platform-agent-consumer-registrations/${intent.sourceNamespace}/${intent.platformAgentId}/owner-binding`;
			const response = await input.authenticatedRequest(
				new Request(target, {
					headers: { accept: "application/json" },
					credentials: "omit",
					redirect: "error",
					signal,
				}),
			);
			if (
				response.status !== 200 ||
				response.redirected ||
				(response.url && response.url !== target) ||
				response.headers
					.get("content-type")
					?.split(";")[0]
					?.trim()
					.toLowerCase() !== "application/json" ||
				!response.headers
					.get("cache-control")
					?.split(",")
					.some((part) => part.trim().toLowerCase() === "no-store") ||
				!response.body
			) {
				void response.body?.cancel().catch(() => {});
				return undefined;
			}
			reader = response.body.getReader();
			signal.addEventListener("abort", cancel, { once: true });
			const chunks: Uint8Array[] = [];
			let size = 0;
			for (;;) {
				signal.throwIfAborted();
				const next = await reader.read();
				signal.throwIfAborted();
				if (next.done) break;
				size += next.value.byteLength;
				if (size > 8192) throw invalid();
				chunks.push(next.value);
			}
			const value = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
			);
			const keys = [
				"schemaVersion",
				"sourceNamespace",
				"platformAgentId",
				"platformOwnerId",
				"policyRevision",
				"ownerPrincipalId",
				"companyId",
				"ownerRevision",
				"expiresAt",
			];
			if (
				!value ||
				Array.isArray(value) ||
				typeof value !== "object" ||
				Object.keys(value).length !== keys.length ||
				keys.some((key) => !Object.hasOwn(value, key)) ||
				value.schemaVersion !== 2 ||
				value.sourceNamespace !== intent.sourceNamespace ||
				value.platformAgentId !== intent.platformAgentId ||
				value.platformOwnerId !== intent.platformOwnerId ||
				value.policyRevision !== intent.policyRevision ||
				![value.ownerPrincipalId, value.companyId, value.ownerRevision].every(
					(v) =>
						typeof v === "string" &&
						v.length > 0 &&
						v.length <= 200 &&
						!/\p{Cc}/u.test(v) &&
						!/^conn_/.test(v),
				) ||
				!Number.isSafeInteger(value.expiresAt) ||
				value.expiresAt <= Date.now() ||
				value.expiresAt > Date.now() + 30_000
			)
				return undefined;
			return {
				sourceNamespace: value.sourceNamespace,
				platformAgentId: value.platformAgentId,
				platformOwnerId: value.platformOwnerId,
				ownerPrincipalId: value.ownerPrincipalId,
				companyId: value.companyId,
			};
		} catch {
			return undefined;
		} finally {
			signal.removeEventListener("abort", cancel);
			await reader?.cancel().catch(() => {});
			reader?.releaseLock();
		}
	};
}

/** Reuses the existing envelope encryptor and Worker port; no new keyring or scheduler. */
export function createConnectionRegistrationWorkerConfigurationV2(input: {
	publicOrigin: string;
	policy: ConnectionRegistrationHttpOptionsV1["policy"];
	credentialFile: string;
	encryptionKeys: unknown;
	ca?: string;
}) {
	const authenticatedRequest = createConnectionRegistrationMachineTransportV2({
		...input,
		sourceNamespace: input.policy.sourceNamespace,
	});
	const adapter = createConnectionConsumerRegistrationHttpAdapterV2({
		...input,
		authenticatedRequest,
		resolveOwnerBinding: createConnectionRegistrationOwnerBindingResolverV2({
			...input,
			authenticatedRequest,
		}),
	});
	if (!adapter) throw invalid();
	const encryptor = createSecretEncryptorV1({
		encryptionKeys: input.encryptionKeys,
	});
	return {
		policy: input.policy,
		adapter,
		encryptCredential: (
			binding: Parameters<typeof connectionServiceCredentialSecretInputV1>[0],
			plaintext: string,
		) =>
			encryptor.encrypt(
				connectionServiceCredentialSecretInputV1(
					binding,
					plaintext,
					new Date().toISOString(),
				),
			),
	};
}
