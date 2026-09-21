import type { PendingSecretRecordAttachmentResolverV1 } from "@agent-infra/platform-core";
import type { SecretEncryptorV1 } from "@agent-infra/secret-store";

import type { ConfigurationRoutesDependencies } from "./http/configuration-routes.js";
import type { ManagementRouteDependencies } from "./http/management-routes.js";

interface SecretValue {
	readonly name: string;
	readonly value: string;
}

/** Plaintext exists only in this request's one-use encryption attachment. */
function attachment(
	encryptor: SecretEncryptorV1,
	agentId: string,
	ownerId: string,
	values: readonly SecretValue[],
): PendingSecretRecordAttachmentResolverV1 | undefined {
	if (values.length === 0) return undefined;
	const pending = new Map(values.map(({ name, value }) => [name, value]));
	if (pending.size !== values.length) {
		throw new TypeError("Secret replacement names must be unique");
	}
	let consumed = false;
	return {
		async resolve({ expected }) {
			if (consumed) throw new TypeError("Secret attachment has been consumed");
			consumed = true;
			try {
				if (
					expected.length !== pending.size ||
					new Set(expected.map(({ name }) => name)).size !== pending.size ||
					expected.some(
						(item) =>
							item.agentId !== agentId ||
							item.ownerType !== "agent-owner" ||
							item.ownerId !== ownerId ||
							!pending.has(item.name),
					)
				) {
					throw new TypeError("Secret attachment does not match the request");
				}
				return expected.map((item) =>
					encryptor.encrypt({
						schemaVersion: 1,
						secretId: item.secretId,
						ownerType: item.ownerType,
						ownerId: item.ownerId,
						agentId: item.agentId,
						name: item.name,
						secretVersion: item.secretVersion,
						configRevision: item.configurationRevision,
						plaintext: pending.get(item.name) as string,
						occurredAt: item.occurredAt,
					}),
				);
			} finally {
				pending.clear();
			}
		},
	};
}

export function createDeploymentSecretPreparation(
	encryptor: SecretEncryptorV1,
): {
	readonly prepareApplicationSecrets: ManagementRouteDependencies["prepareSecretReplacements"];
	readonly prepareConfigurationSecrets: ConfigurationRoutesDependencies["prepareSecretReplacements"];
} {
	return {
		async prepareApplicationSecrets(input) {
			const model = input.modelConfiguration;
			const values = [...input.secrets];
			for (const option of model?.options ?? []) {
				if (option.credentialValue !== undefined) {
					values.push({
						name: `model:${option.optionId}`,
						value: option.credentialValue,
					});
				}
			}
			const prepared = attachment(
				encryptor,
				input.agentId,
				input.identity.userId,
				values,
			);
			return {
				secrets: input.secrets.map(({ name }) => ({ name, replace: true })),
				...(model === undefined
					? {}
					: {
							modelConfiguration: {
								...model,
								options: model.options.map(
									({ credentialValue, ...option }) => ({
										...option,
										replaceCredential: credentialValue !== undefined,
									}),
								),
							},
						}),
				...(prepared === undefined ? {} : { attachment: prepared }),
			};
		},
		async prepareConfigurationSecrets(input) {
			const prepared = attachment(
				encryptor,
				input.agentId,
				input.identity.userId,
				[
					...input.secrets,
					...input.modelCredentials.map(({ optionId, credentialValue }) => ({
						name: `model:${optionId}`,
						value: credentialValue,
					})),
				],
			);
			return {
				secrets: input.secrets.map(({ name }) => ({ name, replace: true })),
				modelCredentialOptionIds: input.modelCredentials.map(
					({ optionId }) => optionId,
				),
				...(prepared === undefined ? {} : { attachment: prepared }),
			};
		},
	};
}
