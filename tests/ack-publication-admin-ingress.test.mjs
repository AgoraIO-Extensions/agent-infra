import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { parseAllDocuments } from "yaml";

const chart =
	process.env.AGENT_INFRA_TEST_PUBLICATION_CHART ??
	resolve(import.meta.dirname, "../deploy/ack/chart");
const host = "ops.example.test";
const api = Buffer.from("export const fixture=true;").toString("base64");
const options = () => ({
	publicOrigin: `https://${host}`,
	ingress: {
		enabled: true,
		className: "private-nginx",
		host,
		tlsSecret: "web-tls",
	},
	configuration: {
		enabled: true,
		api: { "configuration.mjs": api },
		worker: { "configuration.mjs": api },
	},
	automaticTemplatePublication: {
		enabled: true,
		origin: "https://control.example.test",
		secretRef: { name: "publication-authority", key: "bindings" },
	},
	publicationAdminIngress: {
		publicationIds: ["Pi-next"],
		sourceNetwork: { address: "192.0.2.0", prefixLength: 24 },
	},
});

function render(values) {
	return spawnSync(
		"helm",
		["template", "ops", chart, "--kube-version", "1.36.1", "-f", "-"],
		{ input: JSON.stringify(values), encoding: "utf8" },
	);
}

test("the ops CIDR reaches only the two selected browser actions on the existing TLS host", () => {
	const result = render(options());
	assert.equal(result.status, 0, result.stderr);
	const objects = parseAllDocuments(result.stdout).map((d) => d.toJSON());
	const ingress = objects.find(
		(o) =>
			o.kind === "Ingress" &&
			o.metadata.name === "agent-infra-publication-admin",
	);
	assert.ok(ingress);
	assert.equal(ingress.spec.rules[0].host, host);
	assert.equal(ingress.spec.ingressClassName, "private-nginx");
	assert.equal(
		ingress.metadata.annotations[
			"nginx.ingress.kubernetes.io/whitelist-source-range"
		],
		"192.0.2.0/24",
	);
	assert.deepEqual(ingress.spec.tls, [
		{ hosts: [host], secretName: "web-tls" },
	]);
	const paths = ingress.spec.rules[0].http.paths;
	assert.deepEqual(
		paths.map((p) => p.path),
		["prepare-automatic", "revoke-automatic"].map(
			(op) => `/internal/ops/standard-template-releases/Pi-next/${op}`,
		),
	);
	assert.ok(
		paths.every(
			(p) =>
				p.pathType === "Exact" &&
				p.backend.service.name === "agent-infra-web" &&
				p.backend.service.port.number === 8081,
		),
	);
	const web = objects.find(
		(o) => o.kind === "Deployment" && o.metadata.name === "agent-infra-web",
	).spec.template.spec;
	const volume = web.volumes.find((v) => v.name === "publication-admin");
	const config = objects.find(
		(o) => o.kind === "ConfigMap" && o.metadata.name === volume.configMap.name,
	).data["admin.conf"];
	for (const { path } of paths)
		assert.ok(config.includes(`location = ${path} {`));
	assert.ok(config.includes("location / { return 404; }"));
	assert.ok(config.includes("proxy_pass_request_headers off;"));
	assert.doesNotMatch(
		config,
		/worker-ready|status-automatic|activate-automatic|run-automatic/,
	);
});

test("default Web has no approval listener, mount or Ingress", () => {
	const disabled = render({});
	assert.equal(disabled.status, 0, disabled.stderr);
	assert.doesNotMatch(
		disabled.stdout,
		/agent-infra-publication-admin|name: publication, port: 8081|name: nginx-config/,
	);
});

test("admin access requires existing HTTPS nginx host and a non-global network", () => {
	for (const change of [
		(v) => {
			delete v.publicationAdminIngress.sourceNetwork;
		},
		(v) => {
			v.publicationAdminIngress.sourceNetwork = {
				address: "0.0.0.0",
				prefixLength: 0,
			};
		},
		(v) => {
			v.publicationAdminIngress.sourceNetwork = {
				address: "::",
				prefixLength: 0,
			};
		},
		(v) => {
			v.publicationAdminIngress.sourceNetwork.address = "192.0.2.333";
		},
		(v) => {
			v.publicationAdminIngress.sourceNetwork.prefixLength = 33;
		},
		(v) => {
			v.publicationAdminIngress.publicationIds = ["wrong.id"];
		},
		(v) => {
			v.publicationAdminIngress.publicationIds = [];
		},
		(v) => {
			v.publicationAdminIngress.host = "external.example.test";
		},
		(v) => {
			v.automaticTemplatePublication.enabled = false;
		},
		(v) => {
			v.ingress.enabled = false;
		},
		(v) => {
			v.ingress.className = "alb";
		},
		(v) => {
			v.ingress.tlsSecret = "";
		},
		(v) => {
			v.ingress.host = "";
		},
		(v) => {
			v.ingress.host = "*.example.test";
		},
		(v) => {
			v.publicOrigin = "https://another.example.test";
		},
	]) {
		const values = options();
		change(values);
		assert.notEqual(render(values).status, 0, String(change));
	}
	const v6 = options();
	v6.publicationAdminIngress.sourceNetwork = {
		address: "2001:db8::",
		prefixLength: 64,
	};
	const result = render(v6);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /whitelist-source-range: "2001:db8::\/64"/);
});
