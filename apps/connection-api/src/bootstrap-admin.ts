import { resolve } from "node:path";
import { deriveConnectionIdentitySubjectHash } from "@agent-infra/connection-core";
import { PostgresConnectionRepository } from "@agent-infra/connection-store";
import { migrateConnectionDatabase } from "@agent-infra/connection-store/migrations";

import { fullConnectionRuntimeConfig } from "./runtime-config";

function ldapSubjectArgument(arguments_: readonly string[]) {
	const index = arguments_.indexOf("--ldap-subject");
	const subject = index === -1 ? undefined : arguments_[index + 1]?.trim();
	if (!subject || index + 2 !== arguments_.length) {
		throw new Error("Usage: admin:bootstrap --ldap-subject <stable-ldap-uid>");
	}
	return subject;
}

const config = fullConnectionRuntimeConfig();
const migrationDirectory = resolve(
	import.meta.dirname,
	process.env.NODE_ENV === "production"
		? "../migrations/connection"
		: "../../../migrations/connection",
);
await migrateConnectionDatabase(config.databaseUrl, migrationDirectory);
const repository = new PostgresConnectionRepository(
	config.databaseUrl,
	config.credentialKey,
);
try {
	const administrator = await repository.bootstrapConnectionAdministrator({
		identityIssuer: config.ldap.issuer,
		identitySubjectHash: deriveConnectionIdentitySubjectHash({
			environment: config.publicBaseUrl,
			identity: {
				issuer: config.ldap.issuer,
				subject: ldapSubjectArgument(process.argv.slice(2)),
			},
			key: config.identityKey,
		}),
	});
	console.log(`Connection administrator ready: ${administrator.displayName}`);
} finally {
	await repository.close();
}
