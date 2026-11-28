import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { pathToFileURL } from "node:url";
import { parseAllDocuments } from "yaml";

const root = resolve(import.meta.dirname, "..");
const chart =
	process.env.AGENT_INFRA_TEST_PUBLICATION_CHART ??
	join(root, "deploy/ack/chart");
const b64 = (value) => Buffer.from(value).toString("base64");
const templateId = "pi";
const publicationId = "release-pi-v2";
const targetImageDigest = "sha256:" + "a".repeat(64);
const catalogRevision = "revision-v2";
const deploymentRef = "installation-test";
const binding = {
	schemaVersion: 1,
	publicationId,
	templateId,
	targetImageDigest,
	catalogRevision,
	deploymentRef,
	validationRef: "validation-v2",
	servicePrincipalRef: "template-publication",
	authorizationRevision: "approval-v2",
	expiresAt: "2099-01-01T00:00:00.000Z",
	expectedPreviousPublicationId: null,
	operatorIds: [],
};
const fixture = (origin) => ({
	automaticTemplatePublication: {
		enabled: true,
		origin,
		publicationIds: { pi: publicationId },
		secretRef: { name: "publication-authority", key: "publications.json" },
	},
	configuration: {
		enabled: true,
		api: {
			"configuration.mjs": b64("export const component='api'"),
			"template-validation-pi.json": b64(
				JSON.stringify({
					schemaVersion: 2,
					candidate: {
						templateId,
						imageDigest: targetImageDigest,
						configurationRevision: catalogRevision,
					},
					adoption: { target: { installationId: deploymentRef } },
				}),
			),
		},
		worker: { "configuration.mjs": b64("export const component='worker'") },
	},
});

function render(values) {
	return spawnSync(
		"helm",
		["template", "agent-infra", chart, "--kube-version", "v1.36.1", "-f", "-"],
		{
			input: JSON.stringify(values),
			encoding: "utf8",
		},
	);
}

test("publication is opt-in and both deployments must use valid pinned catalog inputs", () => {
	const disabled = render({});
	assert.equal(disabled.status, 0, disabled.stderr);
	assert.doesNotMatch(disabled.stdout, /name: template-publication/);
	for (const change of [
		(v) => {
			v.automaticTemplatePublication.origin = "http://control.invalid";
		},
		(v) => {
			v.configuration.enabled = false;
		},
		(v) => {
			v.automaticTemplatePublication.publicationIds.codex = publicationId;
		},
		(v) => {
			delete v.configuration.api["template-validation-pi.json"];
		},
		(v) => {
			v.deploymentRelease = {
				manifests: {
					"templates-amd64": {
						images: { pi: { digest: "sha256:" + "b".repeat(64) } },
					},
				},
			};
		},
	]) {
		const values = fixture("https://control.invalid");
		change(values);
		assert.notEqual(render(values).status, 0);
	}
});

test("v0.1.7 config-only preparation mounts the legacy API on exact pending IDs and leaves the Worker idle", () => {
	const values = fixture("https://control.invalid");
	values.deploymentRelease = {
		version: "v0.1.7",
		source: { sha: "e423c29734e17aad2414c2ed09fba6dc0586ee21" },
	};
	values.files = { enabled: true };
	values.automaticTemplatePublication.publicationIds = {};
	values.automaticTemplatePublication.bootstrapPrepareIds = {
		pi: "pi-next",
		claude: "claude-next",
	};
	const result = render(values);
	assert.equal(result.status, 0, result.stderr);
	const objects = parseAllDocuments(result.stdout).map((doc) => doc.toJSON());
	function config(component) {
		const spec = objects.find(
			(o) =>
				o.kind === "Deployment" &&
				o.metadata.name === "agent-infra-" + component,
		).spec.template.spec;
		const files = objects.find(
			(o) =>
				o.kind === "Secret" &&
				o.metadata.name ===
					spec.volumes.find((v) => v.name === component + "-configuration")
						.secret.secretName,
		).data;
		return { spec, files };
	}
	const api = config("api");
	assert.equal(
		api.spec.containers
			.find((c) => c.name === "platform-api")
			.env.find((e) => e.name === "PLATFORM_API_DEPLOYMENT_MODULE").value,
		"file:///app/deployment/bootstrap-deployment.mjs",
	);
	assert.match(
		Buffer.from(api.files["bootstrap-deployment.mjs"], "base64").toString(),
		/"claude":"claude-next".*"pi":"pi-next"/,
	);
	assert.ok(api.files["template-publication-bootstrap.mjs"]);
	assert.doesNotMatch(
		Buffer.from(api.files["configuration.mjs"], "base64").toString(),
		/export const automaticTemplatePublication/,
	);
	assert.doesNotMatch(
		Buffer.from(
			config("worker").files["configuration.mjs"],
			"base64",
		).toString(),
		/pi-next|claude-next/,
	);
	for (const change of [
		(v) => (v.deploymentRelease.source.sha = "a".repeat(40)),
		(v) => (v.files.enabled = false),
		(v) => (v.automaticTemplatePublication.publicationIds = { pi: "pi-next" }),
		(v) =>
			(v.automaticTemplatePublication.bootstrapPrepareIds.claude = "pi-next"),
	]) {
		const invalid = structuredClone(values);
		change(invalid);
		assert.notEqual(render(invalid).status, 0);
	}
});

test("rendered API and Worker modules use the release-pinned binding and signed HTTPS transport", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "publication-chart-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	execFileSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-days",
			"1",
			"-subj",
			"/CN=localhost",
			"-addext",
			"subjectAltName=IP:127.0.0.1",
			"-keyout",
			"tls.key",
			"-out",
			"tls.crt",
		],
		{ cwd: dir, stdio: "ignore" },
	);
	const cert = readFileSync(join(dir, "tls.crt"), "utf8");
	const originalCAs = getCACertificates();
	setDefaultCACertificates([...originalCAs, cert]);
	t.after(() => setDefaultCACertificates(originalCAs));

	const events = [];
	let verifier;
	const server = createServer(
		{ cert, key: readFileSync(join(dir, "tls.key")) },
		async (req, res) => {
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			const identity = await verifier.resolveService(
				new Request(origin + req.url, {
					method: req.method,
					headers: req.headers,
					body: chunks.length ? Buffer.concat(chunks) : undefined,
				}),
			);
			if (identity) events.push(identity);
			res.writeHead(identity ? 200 : 403).end();
		},
	);
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	t.after(
		() =>
			new Promise((done) => {
				server.close(done);
				server.closeAllConnections();
			}),
	);
	const origin = "https://127.0.0.1:" + server.address().port;
	const values = fixture(origin);
	const rendered = render(values);
	assert.equal(rendered.status, 0, rendered.stderr);
	const objects = parseAllDocuments(rendered.stdout).map((doc) => doc.toJSON());
	const authorityFile = join(dir, "publications.json");
	const row = (item, keyVersion) => ({
		binding: item,
		keyVersion,
		issuer: "fixture",
		keyBase64: randomBytes(32).toString("base64"),
	});
	const save = (rows) =>
		writeFileSync(
			authorityFile,
			JSON.stringify({ schemaVersion: 1, publications: rows }),
			{ mode: 0o600 },
		);
	const staged = {
		...binding,
		publicationId: "release-pi-v3",
		catalogRevision: "revision-v3",
	};
	save([row(binding, "v1"), row(staged, "v1")]);
	const loaded = {};
	for (const component of ["api", "worker"]) {
		const deployment = objects.find(
			(o) =>
				o.kind === "Deployment" &&
				o.metadata.name === "agent-infra-" + component,
		);
		const pod = deployment.spec.template.spec;
		const mounts = pod.containers.filter((c) =>
			c.volumeMounts?.some((m) => m.name === "template-publication"),
		);
		assert.deepEqual(
			mounts.map((c) => c.name),
			["platform-" + component],
		);
		assert.equal(
			pod.volumes.find((v) => v.name === "template-publication").secret
				.defaultMode,
			0o440,
		);
		if (component === "api") {
			assert.deepEqual(
				JSON.parse(
					Buffer.from(
						deployment.metadata.annotations[
							"agent-infra.agora.io/template-publication-config"
						],
						"base64",
					),
				),
				values.automaticTemplatePublication,
			);
		}
		const configSecret = pod.volumes.find(
			(v) => v.name === component + "-configuration",
		).secret.secretName;
		const files = objects.find(
			(o) => o.kind === "Secret" && o.metadata.name === configSecret,
		).data;
		const app = join(dir, component, "app");
		const moduleDir = join(app, component === "api" ? "deployment" : "dist");
		mkdirSync(moduleDir, { recursive: true });
		symlinkSync(
			join(root, "apps/platform-" + component, "node_modules"),
			join(app, "node_modules"),
			"dir",
		);
		for (const [name, bytes] of Object.entries(files)) {
			const text = Buffer.from(bytes, "base64")
				.toString("utf8")
				.replace(
					"/var/run/agent-infra/template-publication/publications.json",
					authorityFile,
				);
			writeFileSync(join(moduleDir, name), text);
		}
		loaded[component] = await import(
			pathToFileURL(join(moduleDir, "configuration.mjs")).href
		);
	}
	const api = loaded.api.automaticTemplatePublication;
	assert.deepEqual(await api.loadBinding(staged.publicationId), staged);
	assert.equal(api.resolveAdministrator, undefined);
	await assert.rejects(
		api.serviceAuthentication.completedStatusReader(publicationId),
	);
	const publisher = row(binding, "v1");
	const reader = {
		principalRef: "read-completion",
		issuer: "fixture",
		keyVersion: "completion-v1",
		keyBase64: randomBytes(32).toString("base64"),
		expiresAt: "2099-02-01T00:00:00.000Z",
	};
	save([{ ...publisher, completedStatusReader: reader }]);
	const receipt =
		await api.serviceAuthentication.completedStatusReader(publicationId);
	assert.equal(receipt.material.principalRef, reader.principalRef);
	assert.ok(
		receipt.material.key.equals(Buffer.from(reader.keyBase64, "base64")),
	);
	for (const bad of [
		{ ...reader, keyBase64: publisher.keyBase64 },
		{ ...reader, expiresAt: "2000-01-01T00:00:00.000Z" },
	]) {
		save([{ ...publisher, completedStatusReader: bad }]);
		await assert.rejects(
			api.serviceAuthentication.completedStatusReader(publicationId),
		);
	}
	save([publisher]);
	const signer = await import(
		pathToFileURL(join(root, "packages/platform-core/dist/index.mjs")).href
	);
	verifier = signer.createTemplatePublicationServiceVerifierV1({
		currentKey: () => api.serviceAuthentication.currentKey(publicationId),
		consumeNonce: async () => true,
	});
	const [worker] = loaded.worker.automaticTemplatePublications;
	const base =
		origin + "/internal/ops/standard-template-releases/" + publicationId + "/";
	const call = (command) =>
		worker.request(
			new Request(base + command, {
				method: "POST",
				body: '{"schemaVersion":1}',
			}),
		);
	assert.equal((await call("worker-ready")).status, 200);
	save([row(binding, "v2")]);
	assert.equal(
		(await worker.request(new Request(base + "status-automatic"))).status,
		200,
	);
	assert.deepEqual(
		events.map((e) => [e.purpose, e.keyVersion]),
		[
			["ready", "v1"],
			["read", "v2"],
		],
	);
	await assert.rejects(call("activate-automatic"));
	await assert.rejects(
		worker.request(
			new Request(base.replace("127.0.0.1", "localhost") + "status-automatic"),
		),
	);
	save([
		row({ ...binding, targetImageDigest: "sha256:" + "b".repeat(64) }, "v3"),
	]);
	await assert.rejects(call("worker-ready"));
	save([row(binding, "v1"), row(binding, "v2")]);
	await assert.rejects(api.loadBinding(publicationId));
	assert.equal(events.length, 2);
});
