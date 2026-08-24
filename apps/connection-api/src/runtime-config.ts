type RuntimeEnvironment = Record<string, string | undefined>;

export type ConnectionApiRuntimeConfig = {
	databaseUrl: string;
	directConsumer: { id: string; name: string };
	identityKey: Uint8Array;
	ldap: {
		activeAttribute?: string;
		activeValue?: string;
		connectTimeoutMs: number;
		displayNameAttribute: string;
		emailAttribute: string;
		issuer: string;
		operationTimeoutMs: number;
		serviceBindDn: string;
		serviceBindPassword: string;
		uidAttribute: string;
		url: string;
		usernameAttribute: string;
		usersBaseDn: string;
	};
	publicBaseUrl: string;
	resourceUrl: string;
};

export type FullConnectionRuntimeConfig = ConnectionApiRuntimeConfig & {
	credentialKey: Uint8Array;
	github: {
		authorizationUrl?: string;
		clientId: string;
		clientSecret: string;
		redirectUri: string;
		tokenUrl?: string;
	};
};

export type ConnectionWorkerRuntimeConfig = {
	databaseUrl: string;
	github: {
		apiBaseUrl: string;
	};
	credentialKey: Uint8Array;
};

export type ProductionMigrationRuntimeConfig = {
	databaseUrl: string;
};

function requireValue(environment: RuntimeEnvironment, name: string) {
	const value = environment[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function positiveInteger(
	environment: RuntimeEnvironment,
	name: string,
	fallback: number,
) {
	const value = Number(environment[name] ?? fallback);
	if (!Number.isInteger(value) || value < 1 || value > 30_000) {
		throw new Error(`${name} must be an integer between 1 and 30000`);
	}
	return value;
}

/** The bootstrap role only needs the database migration contract. */
export function productionMigrationRuntimeConfig(
	environment: RuntimeEnvironment = process.env,
): ProductionMigrationRuntimeConfig {
	return { databaseUrl: requireValue(environment, "DATABASE_URL") };
}

function requireHttps(value: string, name: string) {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${name} must be an absolute HTTPS URL`);
	}
	if (url.protocol !== "https:") {
		throw new Error(`${name} must use HTTPS`);
	}
	return url.toString();
}

function requirePublicOrigin(value: string, name: string) {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${name} must be an absolute HTTPS or loopback URL`);
	}
	const loopbackHttp =
		url.protocol === "http:" &&
		(url.hostname === "127.0.0.1" || url.hostname === "[::1]");
	if (url.protocol !== "https:" && !loopbackHttp) {
		throw new Error(`${name} must use HTTPS outside exact loopback origins`);
	}
	if (
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	) {
		throw new Error(`${name} must be an origin without path or credentials`);
	}
	return url.toString();
}

function requirePostgres(value: string) {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("DATABASE_URL must be an absolute PostgreSQL URL");
	}
	if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
		throw new Error("DATABASE_URL must be an absolute PostgreSQL URL");
	}
	return value;
}

function key32(value: string, name: string) {
	const bytes = Buffer.from(value, "base64");
	if (bytes.byteLength !== 32 || bytes.toString("base64") !== value) {
		throw new Error(`${name} must be canonical base64 for 32 bytes`);
	}
	return bytes;
}

function optionalHttps(environment: RuntimeEnvironment, name: string) {
	const value = environment[name];
	return value ? requireHttps(value, name) : undefined;
}

export function connectionApiRuntimeConfig(
	environment: RuntimeEnvironment = process.env,
): ConnectionApiRuntimeConfig {
	const activeAttribute = environment.LDAP_ACTIVE_ATTRIBUTE || undefined;
	const activeValue = environment.LDAP_ACTIVE_VALUE || undefined;
	if ((activeAttribute === undefined) !== (activeValue === undefined)) {
		throw new Error(
			"LDAP_ACTIVE_ATTRIBUTE and LDAP_ACTIVE_VALUE must be configured together",
		);
	}
	const publicBaseUrl = requirePublicOrigin(
		requireValue(environment, "CONNECTION_PUBLIC_BASE_URL"),
		"CONNECTION_PUBLIC_BASE_URL",
	);
	const resourceUrl = new URL("/mcp", publicBaseUrl).toString();
	return {
		databaseUrl: requirePostgres(requireValue(environment, "DATABASE_URL")),
		directConsumer: {
			id: requireValue(environment, "CONNECTION_DIRECT_CONSUMER_ID"),
			name: requireValue(environment, "CONNECTION_DIRECT_CONSUMER_NAME"),
		},
		identityKey: key32(
			requireValue(environment, "CONNECTION_IDENTITY_KEY"),
			"CONNECTION_IDENTITY_KEY",
		),
		ldap: {
			...(activeAttribute !== undefined && activeValue !== undefined
				? { activeAttribute, activeValue }
				: {}),
			connectTimeoutMs: positiveInteger(
				environment,
				"LDAP_CONNECT_TIMEOUT_MS",
				5_000,
			),
			displayNameAttribute: requireValue(
				environment,
				"LDAP_DISPLAY_NAME_ATTRIBUTE",
			),
			emailAttribute: requireValue(environment, "LDAP_EMAIL_ATTRIBUTE"),
			issuer: requireValue(environment, "LDAP_ISSUER"),
			operationTimeoutMs: positiveInteger(
				environment,
				"LDAP_OPERATION_TIMEOUT_MS",
				8_000,
			),
			serviceBindDn: requireValue(environment, "LDAP_SERVICE_BIND_DN"),
			serviceBindPassword: requireValue(
				environment,
				"LDAP_SERVICE_BIND_PASSWORD",
			),
			uidAttribute: requireValue(environment, "LDAP_UID_ATTRIBUTE"),
			url: requireValue(environment, "LDAP_URL"),
			usernameAttribute: requireValue(environment, "LDAP_USERNAME_ATTRIBUTE"),
			usersBaseDn: requireValue(environment, "LDAP_USERS_BASE_DN"),
		},
		publicBaseUrl,
		resourceUrl,
	};
}

export function fullConnectionRuntimeConfig(
	environment: RuntimeEnvironment = process.env,
): FullConnectionRuntimeConfig {
	const api = connectionApiRuntimeConfig(environment);
	return {
		...api,
		credentialKey: key32(
			requireValue(environment, "CONNECTION_CREDENTIAL_KEY"),
			"CONNECTION_CREDENTIAL_KEY",
		),
		github: {
			...(optionalHttps(environment, "GITHUB_OAUTH_AUTHORIZATION_URL")
				? {
						authorizationUrl: optionalHttps(
							environment,
							"GITHUB_OAUTH_AUTHORIZATION_URL",
						),
					}
				: {}),
			clientId: requireValue(environment, "GITHUB_OAUTH_CLIENT_ID"),
			clientSecret: requireValue(environment, "GITHUB_OAUTH_CLIENT_SECRET"),
			redirectUri: new URL("/oauth/callback", api.publicBaseUrl).toString(),
			...(optionalHttps(environment, "GITHUB_OAUTH_TOKEN_URL")
				? {
						tokenUrl: optionalHttps(environment, "GITHUB_OAUTH_TOKEN_URL"),
					}
				: {}),
		},
	};
}

/** Parses startup configuration before any provider or database work begins. */
export function connectionWorkerRuntimeConfig(
	environment: RuntimeEnvironment = process.env,
): ConnectionWorkerRuntimeConfig {
	const databaseUrl = requireValue(environment, "DATABASE_URL");
	const key = key32(
		requireValue(environment, "CONNECTION_CREDENTIAL_KEY"),
		"CONNECTION_CREDENTIAL_KEY",
	);
	const apiBaseUrl =
		environment.GITHUB_API_BASE_URL ?? "https://api.github.com";
	requireHttps(apiBaseUrl, "GITHUB_API_BASE_URL");
	return {
		credentialKey: key,
		databaseUrl,
		github: { apiBaseUrl },
	};
}
