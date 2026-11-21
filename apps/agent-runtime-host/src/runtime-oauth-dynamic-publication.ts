import { createHash } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	standardOAuthUnavailable as unavailable,
	validateStandardMcpInstallationMetadata,
} from "@agent-infra/agent-runtime";
import type { ApprovedConnectionConsumerTargetV1 } from "@agent-infra/contracts/connection-consumer-profile";
import type {
	RuntimeOAuthAuthorizedRequestV1,
	RuntimeOAuthScopeV1,
	RuntimePrincipalV1,
} from "@agent-infra/contracts/runtime";
import {
	type RuntimeOAuthDynamicPrincipalMappingV1,
	readProtectedRuntimeOAuthPublication,
} from "./runtime-oauth-publication.js";
import { readProtectedStandardMcpBytes } from "./standard-mcp-files.js";
import {
	ensurePrivateDirectory,
	publishMetadata,
	standardMcpExportKey,
} from "./standard-mcp-installation.js";

/** §13.5.6: every dynamic manual installation publishes under this delivery ref. */
export const runtimeOAuthDynamicDeliveryRefV1 = "connection-manual-install";

/**
 * Deployment-approved dynamic publication contract (§13.5.6 `serviceRef` and
 * `contract`). The Host takes it only from its protected deployment input at
 * assembly; its `ref`/`revision` must equal the descriptor's publication
 * contract.
 */
export interface RuntimeOAuthDynamicPublicationContractV1 {
	readonly serviceRef: string;
	readonly contract: {
		readonly ref: string;
		readonly revision: string;
		readonly serverInfo: { readonly name: string; readonly version: string };
		readonly tools: readonly unknown[];
	};
}

function sha256Hex(value: string) {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/** One revision per installation; a reinstall is a new authorization and revision. */
export function runtimeOAuthDynamicDeliveryV1(
	authorizationId: string,
	confirmationRevision: string,
) {
	return {
		ref: runtimeOAuthDynamicDeliveryRefV1,
		revision: sha256Hex(
			JSON.stringify([authorizationId, confirmationRevision]),
		),
	};
}

interface DynamicTransaction {
	readonly authorizationId: string;
	readonly confirmationRevision: string;
	readonly principal: RuntimePrincipalV1;
	readonly scope: RuntimeOAuthScopeV1;
	readonly reference: RuntimeOAuthAuthorizedRequestV1["reference"];
	readonly configurationFingerprint: string;
}

/**
 * §13.5.6 动态安装的同一 Host 发布 / 动态发布回执的字段. Before the exchange it
 * checks the approved contract against the descriptor and that this
 * installation revision was never published; after one exchange it writes the
 * non-secret receipt once and reads it back with the dynamic key set. Every
 * field comes from the fixed descriptor and configuration, the original
 * transaction, the pinned candidate, the token response's expiry or the
 * deployment contract; none from the request, the callback or Connection's
 * self-reported fields. Any mismatch publishes nothing.
 */
export function createRuntimeOAuthDynamicPublication(options: {
	readonly dataDirectory: string;
	readonly target: ApprovedConnectionConsumerTargetV1;
	readonly principal: RuntimePrincipalV1;
	readonly clientId: string;
	readonly issuer: string;
	readonly resource: string;
	readonly descriptorContract: {
		readonly ref: string;
		readonly revision: string;
	};
	readonly contract: RuntimeOAuthDynamicPublicationContractV1;
	readonly candidate: {
		readonly principalId: string;
		readonly instanceId: string;
	};
}) {
	const target = structuredClone(options.target);
	const principal = structuredClone(options.principal);
	const contract = structuredClone(options.contract);
	const mapping: RuntimeOAuthDynamicPrincipalMappingV1 = {
		kind: "consistency-exception-v1",
		connectionPrincipalId: options.candidate.principalId,
	};
	const publications = join(
		options.dataDirectory,
		"codex-driver.json.native",
		"conversations",
		"standard-mcp-oauth",
		"publications",
	);
	return async (input: {
		transaction: DynamicTransaction;
		signal: AbortSignal;
		assertCurrent: () => void;
	}) => {
		const transaction = structuredClone(input.transaction);
		const guard = input.assertCurrent;
		if (
			contract.contract.ref !== options.descriptorContract.ref ||
			contract.contract.revision !== options.descriptorContract.revision ||
			!isDeepStrictEqual(transaction.principal, principal) ||
			transaction.scope.agentId !== transaction.reference.agentId
		)
			unavailable();
		const delivery = runtimeOAuthDynamicDeliveryV1(
			transaction.authorizationId,
			transaction.confirmationRevision,
		);
		const name = `${standardMcpExportKey(delivery.ref, delivery.revision)}.json`;
		const configurationFingerprint = transaction.configurationFingerprint;
		const metadataBase = {
			schemaVersion: 1,
			principal,
			agentId: transaction.scope.agentId,
			serviceRef: contract.serviceRef,
			consumerId: target.profile.consumerId,
			instanceRef: options.candidate.instanceId,
			issuer: options.issuer,
			resource: options.resource,
			audience: target.profile.audience,
			configFingerprint: target.configFingerprint,
			source: target.source,
			credentialRef: `oauth-${sha256Hex(transaction.authorizationId)}`,
			credentialRevision: sha256Hex(
				JSON.stringify([
					transaction.authorizationId,
					transaction.confirmationRevision,
					configurationFingerprint,
				]),
			),
			contract: contract.contract,
		};
		// Checked before any code or verifier is read: an invalid field never exchanges.
		validateStandardMcpInstallationMetadata(
			{ ...metadataBase, expiresAt: Date.now() + 60_000 },
			target,
		);
		guard();
		const previous = await readProtectedStandardMcpBytes(
			publications,
			name,
			65_536,
			guard,
		).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
			return undefined;
		});
		// Each installation revision is published once; nothing is overwritten.
		if (previous !== undefined) unavailable();
		return async (expiresAt: number) => {
			guard();
			const metadata = validateStandardMcpInstallationMetadata(
				{ ...metadataBase, expiresAt },
				target,
			);
			await ensurePrivateDirectory(publications);
			guard();
			await publishMetadata(
				publications,
				name,
				{
					schemaVersion: 1,
					authorizationId: transaction.authorizationId,
					confirmationRevision: transaction.confirmationRevision,
					clientId: options.clientId,
					configurationFingerprint,
					connectionPrincipalId: mapping.connectionPrincipalId,
					principalMapping: mapping.kind,
					delivery,
					metadata,
					reference: transaction.reference,
					scope: transaction.scope,
				},
				{ guard, immutable: true },
			);
			guard();
			return readProtectedRuntimeOAuthPublication({
				dataDirectory: options.dataDirectory,
				revision: JSON.stringify([delivery.ref, delivery.revision]),
				target,
				clientId: options.clientId,
				configurationFingerprint,
				transaction,
				principalMapping: mapping,
				assertCurrent: guard,
			});
		};
	};
}
