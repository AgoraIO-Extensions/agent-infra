import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { parseAllDocuments } from "yaml";

const chart = "deploy/ack/chart";
const exactHost = "apps.example.test";

type ChartResource = {
	kind?: string;
	metadata?: {
		name?: string;
		namespace?: string;
		annotations?: Record<string, string>;
	};
	spec?: {
		acme?: {
			disableAccountKeyGeneration?: boolean;
			privateKeySecretRef?: { name?: string };
			solvers?: Array<{ selector?: { dnsNames?: string[] } }>;
		};
		dnsNames?: string[];
		secretName?: string;
		issuerRef?: { name?: string };
	};
};

const render = (...args: string[]): ChartResource[] =>
	parseAllDocuments(
		execFileSync("helm", ["template", "cert-manager-test", chart, ...args], {
			encoding: "utf8",
		}),
	)
		.map((document) => document.toJSON() as ChartResource)
		.filter((document) => Boolean(document));

const certManagerResources = (documents: ChartResource[]) =>
	documents.filter((document) =>
		["Issuer", "Certificate"].includes(document.kind ?? ""),
	);

const certManagerArgs = (
	options: {
		readonly databaseOnly?: boolean;
		readonly authorizationRef?: string;
		readonly dnsName?: string;
	} = {},
) => [
	...(options.databaseOnly
		? ["--set", "bootstrap.databaseOnly=true", "--set", "postgres.enabled=true"]
		: []),
	"--set",
	"certManager.enabled=true",
	"--set",
	"certManager.renewalOwner=sre-pki",
	"--set",
	"certManager.issuer.name=agent-infra-apps-letsencrypt-prod",
	"--set",
	"certManager.issuer.accountSecretName=d-letsencrypt-account",
	...(options.authorizationRef
		? [
				"--set",
				`certManager.issuer.acmeAuthorizationRef=${options.authorizationRef}`,
			]
		: []),
	"--set",
	"certManager.certificate.name=agent-infra-apps-tls",
	"--set",
	"certManager.certificate.secretName=agent-infra-apps-tls",
	"--set",
	`certManager.certificate.dnsNames[0]=${options.dnsName ?? exactHost}`,
];

test("CERT-B stays default-off and renders no cert-manager resources", () => {
	assert.deepEqual(certManagerResources(render()), []);
});

test("CERT-B does not render during database-only bootstrap", () => {
	assert.deepEqual(
		certManagerResources(
			render(
				...certManagerArgs({
					databaseOnly: true,
					authorizationRef: "workorder-26458",
				}),
			),
		),
		[],
	);
});

test("CERT-B opt-in renders the configured Issuer and Certificate without key material", () => {
	const resources = certManagerResources(
		render(
			"--namespace",
			"agent-infra-d-ws-1103",
			...certManagerArgs({ authorizationRef: "workorder-26458" }),
		),
	);
	assert.deepEqual(resources.map((resource) => resource.kind).sort(), [
		"Certificate",
		"Issuer",
	]);
	const issuer = resources.find((resource) => resource.kind === "Issuer");
	const certificate = resources.find(
		(resource) => resource.kind === "Certificate",
	);
	assert(issuer?.metadata && issuer.spec?.acme && certificate?.spec);
	assert.equal(issuer.metadata.namespace, "agent-infra-d-ws-1103");
	assert.equal(issuer.spec.acme.disableAccountKeyGeneration, true);
	assert.equal(
		issuer.spec.acme.privateKeySecretRef?.name,
		"d-letsencrypt-account",
	);
	assert.deepEqual(issuer.spec.acme.solvers?.[0]?.selector?.dnsNames, [
		exactHost,
	]);
	assert.equal(
		issuer.metadata.annotations?.[
			"agent-infra.agora.io/acme-authorization-ref"
		],
		"workorder-26458",
	);
	assert.deepEqual(certificate.spec.dnsNames, [exactHost]);
	assert.equal(certificate.spec.secretName, "agent-infra-apps-tls");
	assert.equal(certificate.spec.issuerRef?.name, issuer.metadata.name);
});

test("CERT-B rejects an enabled configuration without an authorization reference", () => {
	const result = spawnSync(
		"helm",
		["template", "cert-manager-test", chart, ...certManagerArgs()],
		{ encoding: "utf8" },
	);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /acmeAuthorizationRef|certManager/);
});

test("CERT-B rejects wildcard DNS names", () => {
	const result = spawnSync(
		"helm",
		[
			"template",
			"cert-manager-test",
			chart,
			...certManagerArgs({
				authorizationRef: "workorder-26458",
				dnsName: "*.example.test",
			}),
		],
		{ encoding: "utf8" },
	);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /dnsNames|certManager/);
});

test("existing D Issuer renders only the exact Certificate without account input or Issuer ownership", () => {
	const resources = certManagerResources(
		render(
			"--namespace",
			"agent-infra-d-ws-1103",
			...certManagerArgs({ authorizationRef: "owner-decision" }),
			"--set",
			"certManager.issuer.create=false",
			"--set",
			"certManager.issuer.name=d-letsencrypt-prod",
			"--set",
			"certManager.issuer.accountSecretName=",
		),
	);
	assert.equal(resources.length, 1);
	assert.equal(resources[0]?.kind, "Certificate");
	assert.equal(resources[0]?.spec?.issuerRef?.name, "d-letsencrypt-prod");
	assert.deepEqual(resources[0]?.spec?.dnsNames, [exactHost]);
	assert.equal(resources[0]?.spec?.secretName, "agent-infra-apps-tls");
});
test("existing Issuer references accept a namespace-scoped issuer name", () => {
	const resources = certManagerResources(
		render(
			"--namespace",
			"another-environment",
			...certManagerArgs({ authorizationRef: "owner-decision" }),
			"--set",
			"certManager.issuer.create=false",
			"--set",
			"certManager.issuer.name=shared-issuer",
			"--set",
			"certManager.issuer.accountSecretName=",
		),
	);
	assert.deepEqual(
		resources.map((resource) => resource.kind),
		["Certificate"],
	);
	assert.equal(resources[0]?.spec?.issuerRef?.name, "shared-issuer");
});

test("existing Issuer references reject an invalid issuer name", () => {
	const result = spawnSync(
		"helm",
		[
			"template",
			"cert-manager-test",
			chart,
			...certManagerArgs({ authorizationRef: "owner-decision" }),
			"--set",
			"certManager.issuer.create=false",
			"--set",
			"certManager.issuer.name=invalid/name",
		],
		{ encoding: "utf8" },
	);
	assert.notEqual(result.status, 0);
});
test("existing Issuer reference still requires authorization and remains disabled during bootstrap", () => {
	const args = [
		"--namespace",
		"agent-infra-d-ws-1103",
		...certManagerArgs(),
		"--set",
		"certManager.issuer.create=false",
		"--set",
		"certManager.issuer.name=d-letsencrypt-prod",
	];
	assert.notEqual(
		spawnSync("helm", ["template", "cert-manager-test", chart, ...args], {
			encoding: "utf8",
		}).status,
		0,
	);
	assert.deepEqual(
		certManagerResources(
			render(
				...args,
				"--set",
				"certManager.issuer.acmeAuthorizationRef=owner-decision",
				"--set",
				"bootstrap.databaseOnly=true",
				"--set",
				"postgres.enabled=true",
			),
		),
		[],
	);
	assert.deepEqual(
		certManagerResources(render(...args, "--set", "certManager.enabled=false")),
		[],
	);
});
