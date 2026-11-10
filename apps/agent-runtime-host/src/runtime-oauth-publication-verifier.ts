import { createHash } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	standardOAuthUnavailable as unavailable,
	validateStandardMcpInstallationMetadata,
	validateStandardMcpToken,
} from "@agent-infra/agent-runtime";
import type { ApprovedConnectionConsumerTargetV1 } from "@agent-infra/contracts/connection-consumer-profile";
import {
	type RuntimeOAuthAuthorizedRequestV1,
	type RuntimeOAuthBindingReadDescriptorV1,
	RuntimeOAuthBindingReadDescriptorV1Schema,
	type RuntimeOAuthConfigurationV1,
	type RuntimeOAuthScopeV1,
	type RuntimePrincipalV1,
} from "@agent-infra/contracts/runtime";
import { runtimeOAuthConfigurationFingerprintV1 } from "@agent-infra/contracts/runtime/oauth-installation-node";
import { readProtectedRuntimeOAuthPublication } from "./runtime-oauth-publication.js";
import { readProtectedStandardMcpBytes } from "./standard-mcp-files.js";
import {
	ensurePrivateDirectory,
	publishMetadata,
	standardMcpExportKey,
} from "./standard-mcp-installation.js";

type Transaction = {
	authorizationId: string;
	confirmationRevision: string;
	connectionPrincipalId?: string;
	principal: RuntimePrincipalV1;
	scope: RuntimeOAuthScopeV1;
	reference: RuntimeOAuthAuthorizedRequestV1["reference"];
};
function object(value: unknown): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}
function exact(value: Record<string, unknown>, expected: string) {
	return Object.keys(value).sort().join(",") === expected;
}
async function boundedJson(response: Response, guard: () => void) {
	const reader = response.body?.getReader();
	if (!reader) unavailable();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			guard();
			const chunk = await reader.read();
			guard();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > 65_536) unavailable();
			chunks.push(chunk.value);
		}
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
		) as unknown;
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

/** Read only the original client binding, before code/verifier access or exchange. */
export async function createProtectedRuntimeOAuthPublicationVerifier(options: {
	dataDirectory: string;
	configuration: RuntimeOAuthConfigurationV1;
	publicationRevision: string | undefined;
	target: ApprovedConnectionConsumerTargetV1;
	principal: RuntimePrincipalV1;
	serviceToken: string;
	fetch?: typeof fetch;
}) {
	const configuration = structuredClone(options.configuration);
	const target = structuredClone(options.target);
	const principal = structuredClone(options.principal);
	if (
		configuration.patBinding ||
		"clientRegistration" in configuration ||
		new URL(configuration.callbackUrl).protocol !== "https:" ||
		principal.kind !== "user" ||
		!options.publicationRevision
	)
		unavailable();
	const selected: unknown = JSON.parse(options.publicationRevision);
	if (
		!Array.isArray(selected) ||
		selected.length !== 2 ||
		selected.some(
			(v) =>
				typeof v !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v),
		)
	)
		unavailable();
	const [ref, revision] = selected as [string, string];
	const delivery = { ref, revision };
	const root = join(
		options.dataDirectory,
		"codex-driver.json.native",
		"conversations",
		"standard-mcp-oauth",
	);
	const bootstrap = join(root, "bootstrap");
	const text = await readProtectedStandardMcpBytes(
		bootstrap,
		"registration.json",
		65_536,
	);
	const descriptor: RuntimeOAuthBindingReadDescriptorV1 =
		RuntimeOAuthBindingReadDescriptorV1Schema.parse(JSON.parse(text));
	const configurationFingerprint =
		runtimeOAuthConfigurationFingerprintV1(configuration);
	if (
		descriptor.clientId !== configuration.clientId ||
		descriptor.configurationFingerprint !== configurationFingerprint
	)
		unavailable();
	const tls = join(root, "tls");
	const secret = validateStandardMcpToken(
		await readProtectedStandardMcpBytes(tls, "registration.auth", 4096),
	);
	const callbackToken = validateStandardMcpToken(
		await readProtectedStandardMcpBytes(tls, "callback.auth", 4096),
	);
	if (
		!options.serviceToken ||
		secret === options.serviceToken ||
		secret === callbackToken
	)
		unavailable();
	const endpoint = new URL(
		`/connection/v1/agents/${encodeURIComponent(target.profile.consumerId)}/oauth-clients/${encodeURIComponent(descriptor.registrationKey)}`,
		configuration.issuer,
	);
	async function current(guard: () => void) {
		guard();
		if (
			(await readProtectedStandardMcpBytes(
				bootstrap,
				"registration.json",
				65_536,
				guard,
			)) !== text ||
			(await readProtectedStandardMcpBytes(
				tls,
				"registration.auth",
				4096,
				guard,
			)) !== secret
		)
			unavailable();
		guard();
	}
	return async (input: {
		transaction: Transaction;
		signal: AbortSignal;
		assertCurrent: () => void;
	}) => {
		const transaction = structuredClone(input.transaction);
		const guard = input.assertCurrent;
		if (
			!transaction.connectionPrincipalId ||
			!isDeepStrictEqual(transaction.principal, principal)
		)
			unavailable();
		await current(guard);
		const publications = join(root, "publications");
		const name = `${standardMcpExportKey(ref, revision)}.json`;
		const previous = await readProtectedStandardMcpBytes(
			publications,
			name,
			65_536,
			guard,
		).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
			return undefined;
		});
		if (previous !== undefined) unavailable();
		const signal = AbortSignal.any([input.signal, AbortSignal.timeout(10_000)]);
		signal.throwIfAborted();
		const response = await (options.fetch ?? fetch)(endpoint, {
			method: "GET",
			headers: {
				authorization: `Bearer ${secret}`,
				accept: "application/json",
			},
			credentials: "omit",
			redirect: "error",
			signal,
		});
		guard();
		if (response.status !== 200 || response.redirected) {
			await response.body?.cancel().catch(() => undefined);
			unavailable();
		}
		const value = await boundedJson(response, guard);
		await current(guard);
		if (
			!object(value) ||
			!exact(value, "outcome,registration,registrationVersion") ||
			value.registrationVersion !== 1 ||
			value.outcome !== "KNOWN" ||
			!object(value.registration)
		)
			unavailable();
		const r = value.registration;
		if (
			!exact(
				r,
				"clientId,clientName,clientStatus,configFingerprint,consumerId,createdAt,instanceId,instanceStatus,principalId,redirectUri,registrationKey,resource,scope,source,status",
			) ||
			r.clientId !== configuration.clientId ||
			r.clientName !== descriptor.clientName ||
			r.consumerId !== target.profile.consumerId ||
			r.instanceId !== descriptor.instanceId ||
			r.principalId !== transaction.connectionPrincipalId ||
			r.registrationKey !== descriptor.registrationKey ||
			r.redirectUri !== configuration.callbackUrl ||
			r.resource !== configuration.resource ||
			r.scope !== configuration.scope ||
			r.configFingerprint !== configuration.configFingerprint ||
			!isDeepStrictEqual(r.source, configuration.source) ||
			r.status !== "ACTIVE" ||
			r.clientStatus !== "ACTIVE" ||
			r.instanceStatus !== "ACTIVE" ||
			typeof r.createdAt !== "string" ||
			!Number.isFinite(Date.parse(r.createdAt))
		)
			unavailable();
		const metadataBase = {
			schemaVersion: 1,
			principal,
			agentId: transaction.scope.agentId,
			serviceRef: descriptor.serviceRef,
			consumerId: r.consumerId,
			instanceRef: r.instanceId,
			issuer: configuration.issuer,
			resource: configuration.resource,
			audience: target.profile.audience,
			configFingerprint: target.configFingerprint,
			source: target.source,
			credentialRef: `oauth-${createHash("sha256").update(transaction.authorizationId).digest("hex")}`,
			credentialRevision: createHash("sha256")
				.update(
					JSON.stringify([
						transaction.authorizationId,
						transaction.confirmationRevision,
						configurationFingerprint,
					]),
				)
				.digest("hex"),
			contract: descriptor.contract,
		};
		validateStandardMcpInstallationMetadata(
			{ ...metadataBase, expiresAt: Date.now() + 60_000 },
			target,
		);
		return async (expiresAt: number) => {
			await current(guard);
			const metadata = validateStandardMcpInstallationMetadata(
				{ ...metadataBase, expiresAt },
				target,
			);
			await ensurePrivateDirectory(publications);
			await current(guard);
			await publishMetadata(
				publications,
				name,
				{
					schemaVersion: 1,
					authorizationId: transaction.authorizationId,
					confirmationRevision: transaction.confirmationRevision,
					clientId: configuration.clientId,
					configurationFingerprint,
					connectionPrincipalId: transaction.connectionPrincipalId,
					delivery,
					metadata,
					reference: transaction.reference,
					scope: transaction.scope,
				},
				{ guard, immutable: true },
			);
			await current(guard);
			return readProtectedRuntimeOAuthPublication({
				dataDirectory: options.dataDirectory,
				revision: options.publicationRevision,
				target,
				clientId: configuration.clientId,
				configurationFingerprint,
				transaction,
				assertCurrent: guard,
			});
		};
	};
}
