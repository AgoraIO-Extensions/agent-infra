import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
	BrowserSessionService,
	createLdaptsAuthenticator,
	LoginThrottle,
	PrincipalIdentityResolver,
} from "@agent-infra/connection-identity";
import {
	connectionDatabaseUrlFromEnvironment,
	createAuditEventStore,
	createBrowserSessionStore,
	createConnectionDatabase,
	createPostgresPrincipalDirectory,
	createPrincipalIdentityStore,
} from "@agent-infra/connection-store";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";

import { connectionApiService, createConnectionApp } from "./app";
import type { ConnectionAuthDependencies } from "./auth";

interface StartOptions {
	log?: (message: string) => void;
	port?: number;
}

function runtimePort(value: string | undefined, fallback: number) {
	const port = Number(value ?? fallback);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(`Invalid PORT: ${value}`);
	}
	return port;
}

function authFromEnvironment():
	| {
			dependencies: ConnectionAuthDependencies;
			close: () => Promise<void>;
	  }
	| undefined {
	const keys = [
		"CONNECTION_DATABASE_URL",
		"CONNECTION_LDAP_ISSUER",
		"CONNECTION_LDAP_URL",
		"CONNECTION_LDAP_BASE_DN",
		"CONNECTION_LDAP_SERVICE_DN",
		"CONNECTION_LDAP_SERVICE_PASSWORD",
		"CONNECTION_PUBLIC_ORIGIN",
		"CONNECTION_ENVIRONMENT",
		"CONNECTION_CSRF_SECRET",
	] as const;
	if (keys.every((key) => !process.env[key])) return undefined;
	if (keys.some((key) => !process.env[key]))
		throw new Error("Connection authentication configuration is incomplete");
	const origin = process.env.CONNECTION_PUBLIC_ORIGIN ?? "";
	let parsedOrigin: URL;
	try {
		parsedOrigin = new URL(origin);
	} catch {
		throw new Error("Connection public origin is invalid");
	}
	if (
		parsedOrigin.protocol !== "https:" ||
		parsedOrigin.origin !== origin ||
		parsedOrigin.pathname !== "/" ||
		parsedOrigin.search ||
		parsedOrigin.hash
	)
		throw new Error("Connection public origin must be HTTPS");
	const encodedKey = process.env.CONNECTION_CSRF_SECRET ?? "";
	if (!/^[A-Za-z0-9_-]+$/.test(encodedKey))
		throw new Error("Connection CSRF secret is invalid");
	const csrfKey = Buffer.from(encodedKey, "base64url");
	if (csrfKey.length < 32 || csrfKey.toString("base64url") !== encodedKey)
		throw new Error("Connection CSRF secret is invalid");
	const profile = {
		issuer: process.env.CONNECTION_LDAP_ISSUER ?? "",
		url: process.env.CONNECTION_LDAP_URL ?? "",
		baseDn: process.env.CONNECTION_LDAP_BASE_DN ?? "",
		serviceDn: process.env.CONNECTION_LDAP_SERVICE_DN ?? "",
		servicePassword: process.env.CONNECTION_LDAP_SERVICE_PASSWORD ?? "",
	};
	const ldap = createLdaptsAuthenticator(
		profile,
		process.env.CONNECTION_LDAP_CA_PEM,
	);
	const database = createConnectionDatabase(
		connectionDatabaseUrlFromEnvironment(),
	);
	const principalStore = createPrincipalIdentityStore(database.db);
	const sessionStore = createBrowserSessionStore(database.db);
	const auditStore = createAuditEventStore(database.db);
	return {
		dependencies: {
			ldap,
			principals: new PrincipalIdentityResolver(principalStore),
			sessions: new BrowserSessionService(
				sessionStore,
				principalStore,
				createPostgresPrincipalDirectory(database.db, profile.issuer, ldap),
			),
			throttle: new LoginThrottle(),
			publicOrigin: origin,
			environment: process.env.CONNECTION_ENVIRONMENT ?? "",
			csrfKey,
			source: (context) => getConnInfo(context).remote.address ?? "",
			audit: async (input) => {
				await auditStore.insert({
					id: randomUUID(),
					traceId: randomUUID(),
					principalId: input.principalId,
					action: input.action,
					targetType: "principal",
					targetId: input.principalId ?? "unknown",
					outcome: input.outcome,
					metadata: {},
				});
			},
		},
		close: database.close,
	};
}

export function startConnectionApi(options: StartOptions = {}) {
	const port = options.port ?? runtimePort(process.env.PORT, 3002);
	const log = options.log ?? console.info;
	const auth = authFromEnvironment();
	const server = serve(
		{
			fetch: createConnectionApp(auth?.dependencies).fetch,
			port,
		},
		(info) =>
			log(
				JSON.stringify({
					service: connectionApiService,
					status: "ready",
					port: info.port,
				}),
			),
	);
	if (auth) server.on("close", () => void auth.close());
	return server;
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
	startConnectionApi();
}
