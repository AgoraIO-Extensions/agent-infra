import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseAllDocuments } from "yaml";

const protocolExamples = [
	"/mcp",
	"/.well-known/oauth-authorization-server",
	"/.well-known/oauth-protected-resource/mcp",
	"/oauth/register",
	"/oauth/token",
	"/oauth/revoke",
	"/oauth/callback",
	"/oauth/github/callback",
	"/api/v1/connection/identity/oauth/callback",
	"/api/v1/connection/pat-bindings",
	"/api/v1/connection/pat-bindings/binding-123/claim",
	"/connection/internal/v1/action-calls",
	"/connection/v1/consumer-instances/instance-123/session",
	"/api/grants/grant-123/revoke",
	"/api/connections/connection-123/disconnect",
];

const publicExamples = [
	"/healthz",
	"/connection",
	"/connection/",
	"/connection/index.html",
	"/connection/agent",
	"/connection/agent/",
	"/connection/agent/index.html",
	"/connection/agent/llms.txt",
	"/connection/help",
	"/connection/help/",
	"/connection/help/user-manual.md",
	"/connection/install.css",
	"/llms.txt",
	"/assets/index-test.js",
];

const documents = parseAllDocuments(
	await readFile("deploy/connection-hci-ingress.yaml", "utf8"),
).map((document) => {
	assert.deepEqual(document.errors, []);
	return document.toJSON();
});
const ingresses = documents.filter((document) => document.kind === "Ingress");
const routes = ingresses.flatMap((ingress) =>
	ingress.spec.rules.flatMap((rule) =>
		rule.http.paths.map((route) => ({ ...route, ingress })),
	),
);

// Match the paths emitted by the deployed KIC 3.5, including its unanchored
// Exact conversion. Never grant tests stricter semantics than the real gateway.
function kongPaths(route) {
	if (route.pathType === "Exact") return [`~${route.path}$`];
	if (route.pathType === "ImplementationSpecific")
		return [`~${route.path.slice(2)}`];
	return route.path === "/" ? ["/"] : [`${route.path}/`, `~${route.path}$`];
}

function routeFor(path) {
	const matching = routes.filter((route) =>
		kongPaths(route).some((pattern) =>
			pattern.startsWith("~")
				? new RegExp(pattern.slice(1)).test(path)
				: path.startsWith(pattern),
		),
	);
	const rank = (route) =>
		route.pathType === "Prefix"
			? route.path.length
			: 1000 +
				Number(
					route.ingress.metadata.annotations["konghq.com/regex-priority"] ?? 0,
				);
	matching.sort((a, b) => rank(b) - rank(a));
	assert.ok(matching[0], `No route for ${path}`);
	return matching[0].ingress;
}

function protectedByHci(path) {
	return (
		routeFor(path).metadata.annotations["konghq.com/plugins"] ===
		"connection-hci-auth"
	);
}

test("HCI belongs only to the Shanghai browser ingress, never a Service", () => {
	assert.deepEqual(
		documents.map((document) => document.kind),
		["KongPlugin", "Ingress", "Ingress", "Ingress"],
	);
	assert.deepEqual(documents[0].config, {
		key_names: ["apiKey"],
		anonymous: "agora-hciauth-v1",
		hide_credentials: true,
	});
	assert.equal(documents[0].plugin, "key-auth");
	for (const document of documents)
		assert.equal(document.metadata.namespace, "agent-connector");
	for (const ingress of ingresses) {
		assert.equal(ingress.spec.ingressClassName, "kong");
		assert.equal(ingress.spec.rules.length, 1);
		assert.equal(ingress.spec.rules[0].host, "agent-connector.agoralab.co");
		assert.equal(ingress.metadata.annotations["konghq.com/protocols"], "https");
		assert.equal(
			ingress.metadata.annotations["konghq.com/https-redirect-status-code"],
			"308",
		);
		assert.equal(
			ingress.metadata.annotations["konghq.com/strip-path"],
			"false",
		);
	}
	for (const route of routes) {
		assert.deepEqual(route.backend.service, {
			name: "connection-web",
			port: { number: 8080 },
		});
		if (route.pathType === "ImplementationSpecific") {
			assert.ok(route.path.startsWith("/~/(?<=^/)"));
			assert.ok(route.path.endsWith("$"));
			assert.equal(
				route.ingress.metadata.annotations["konghq.com/regex-priority"],
				"100",
			);
		}
	}
	assert.deepEqual(
		ingresses
			.filter((ingress) => ingress.metadata.annotations["konghq.com/plugins"])
			.map((ingress) => ingress.metadata.name),
		["connection-web"],
	);
});

test("browser LDAP login, consent and management still require entrance admission", () => {
	for (const path of [
		"/connection/login",
		"/connection/connections",
		"/connection/tokens",
		"/connection/admin/administrators",
		"/connection/pat-bindings/user-confirmation",
		"/connection/pat-bindings/confirm",
		"/oauth/authorize",
		"/oauth/login",
		"/api/v1/connection/session",
		"/api/v1/connection/tokens",
		"/api/v1/connection/connections",
		"/api/v1/connection/admin/employee-candidates",
		"/api/v1/connection/identity/oauth/probe",
		"/api/overview",
		"/api/github/oauth/start",
	]) {
		assert.equal(protectedByHci(path), true, path);
	}
});

test("OAuth clients, Agents and callbacks need no HCI cookie or extra key", () => {
	for (const path of protocolExamples) {
		assert.equal(protectedByHci(path), false, path);
		assert.equal(routeFor(path).metadata.name, "connection-protocol", path);
	}
});

test("public installation/help assets remain readable without browser admission", () => {
	for (const path of publicExamples) {
		assert.equal(protectedByHci(path), false, path);
		assert.equal(routeFor(path).metadata.name, "connection-public", path);
	}
});

test("prefix collisions, extra segments and future APIs cannot broaden exceptions", () => {
	for (const path of [
		"/mcp-admin",
		"/prefix/api/v1/connection/pat-bindings/a/claim",
		"/prefix/connection/v1/consumer-instances/a/session",
		"/prefix/api/grants/a/revoke",
		"/prefix/api/connections/a/disconnect",
		"/oauth/token/admin",
		"/oauth/callback-extra",
		"/oauth/new-browser-route",
		"/api/v1/connection/pat-bindings/administration",
		"/api/v1/connection/pat-bindings/a/b/claim",
		"/api/v1/connection/pat-bindings/a/claim/extra",
		"/api/v1/connection/identity/oauth/callback-extra",
		"/api/v1/connection/new-browser-route",
		"/connection/v1/consumer-instances/a/b/session",
		"/api/grants/a/revoke/extra",
		"/api/connections/a/disconnect/extra",
		"/connection/agent/admin",
		"/assets-admin",
		"/healthz-admin",
	]) {
		assert.equal(protectedByHci(path), true, path);
	}
});

test("every exception rejects extra prefixes, suffixes and nonliteral dots after KIC translation", () => {
	for (const path of [...protocolExamples, ...publicExamples]) {
		assert.equal(protectedByHci(`/prefix${path}`), true, path);
		if (path.startsWith("/assets/")) continue;
		assert.equal(protectedByHci(`${path}/extra`), true, path);
		if (path.includes("."))
			assert.equal(protectedByHci(path.replaceAll(".", "X")), true, path);
	}
});
