const POSTGRES_PROTOCOLS = new Set(["postgres:", "postgresql:"]);

function databaseTarget(value: string, label: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${label} must be a valid PostgreSQL URL`);
	}
	if (!POSTGRES_PROTOCOLS.has(url.protocol)) {
		throw new Error(`${label} must be a valid PostgreSQL URL`);
	}

	const rawHost = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	const host = ["localhost", "127.0.0.1", "::1", "0:0:0:0:0:0:0:1"].includes(
		rawHost,
	)
		? "loopback"
		: rawHost;
	let database: string;
	try {
		database = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, "");
	} catch {
		throw new Error(`${label} must be a valid PostgreSQL URL`);
	}
	if (!host || !database) {
		throw new Error(`${label} must be a valid PostgreSQL URL`);
	}
	return `${host}:${url.port || "5432"}/${database}`;
}

export function assertIsolatedTestDatabaseUrl(
	testDatabaseUrl: string | undefined,
	runtimeDatabaseUrl: string | undefined,
): void {
	if (!testDatabaseUrl || !runtimeDatabaseUrl) return;
	if (
		databaseTarget(testDatabaseUrl, "CONNECTION_TEST_DATABASE_URL") ===
		databaseTarget(runtimeDatabaseUrl, "DATABASE_URL")
	) {
		throw new Error(
			"CONNECTION_TEST_DATABASE_URL must use a database separate from DATABASE_URL",
		);
	}
}
