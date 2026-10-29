import assert from "node:assert/strict";
import { readAgentBindings } from "./agent-bindings.ts";
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, sign, X509Certificate } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseAllDocuments } from "yaml";
import { readAuthorization, verifyCustomAgentWeb } from "../../tests/local-real-e2e/custom-agent-web-probe.ts";
import { privateBytes, privateJson } from "./private-input.ts";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const ownerLabel = "agent-infra.agora.io/agent";
const agentAnnotation = "agent-infra.agora.io/agent-id";
const revisionLabel = "agent-infra.agora.io/revision";
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
type Item = Record<string, any>;
type Read = (kind: string) => Item[];

export function verifyOwnEntryWorkloads(agentId: string, source: Item, origin: string, read: Read, environment: Item[] = []) {
	const prefix = `agent-${hash(agentId).slice(0, 32)}`;
	assert(source.kind === "custom" && source.interactionMode === "self-managed" && source.identityResponsibility === "self-managed");
	let services: { name: string; workload: string; kind: string; ports: number[]; images: string[]; environments: Item[][]; entry: boolean }[];
	if (source.manifest !== undefined) {
		const docs = parseAllDocuments(source.manifest).map(document => { assert.equal(document.errors.length, 0); return document.toJSON(); }).filter(Boolean);
		const resources: Item[] = docs.length === 1 && Array.isArray(docs[0].resources) ? docs[0].resources : docs;
		services = resources.filter(resource => resource.kind === "Service").map(service => {
			const matches = resources.filter(resource => ["Deployment", "StatefulSet"].includes(resource.kind) &&
				Object.entries(service.spec.selector).every(([key, value]) => resource.spec.template.metadata.labels[key] === value));
			assert.equal(matches.length, 1);
			return { name: `${prefix}-${service.metadata.name}`, workload: `${prefix}-${matches[0].metadata.name}`, kind: matches[0].kind,
				ports: service.spec.ports.map((port: Item) => port.port), images: matches[0].spec.template.spec.containers.map((container: Item) => container.image),
				environments: matches[0].spec.template.spec.containers.map((container: Item) => container.env ?? []),
				entry: service.metadata.annotations?.["agent-infra.agora.io/entry"] === "true" };
		});
		assert(services.length >= 2 && services.length <= 16 && services.filter(service => service.entry).length === 1);
	} else {
		const imageDigest = source.imageReference?.split("@")[1]; assert(digestPattern.test(imageDigest));
		services = [{ name: prefix, workload: prefix, kind: "StatefulSet", ports: [], images: [imageDigest], environments: [environment], entry: true }];
	}
	const all = Object.fromEntries(["Deployment", "StatefulSet", "ReplicaSet", "Service", "Pod", "EndpointSlice", "Ingress"].map(kind => [kind, read(kind)]));
	const owned = (object: Item) => object.metadata?.labels?.[ownerLabel] === prefix && object.metadata.annotations?.[agentAnnotation] === agentId;
	const identities: { kind: string; uid: string; resourceVersion: string }[] = [];
	const capture = (object: Item) => {
		assert(object.metadata?.uid && object.metadata.resourceVersion);
		identities.push({ kind: object.kind, uid: object.metadata.uid, resourceVersion: object.metadata.resourceVersion });
	};
	for (const expected of services) {
		assert(expected.images.every(image => digestPattern.test(image)));
		const workloads = all[expected.kind].filter(object => object.metadata.name === expected.workload && owned(object)); assert.equal(workloads.length, 1);
		const workload = workloads[0];
		assert(workload.status?.observedGeneration === workload.metadata.generation && workload.status.readyReplicas === 1 && workload.spec.replicas === 1);
		assert.deepEqual(workload.spec.template.spec.containers.map((container: Item) => container.image.split("@")[1]).sort(), [...expected.images].sort());
		for (const [index, declared] of expected.environments.entries()) for (const entry of declared)
			assert(workload.spec.template.spec.containers[index].env?.some((actual: Item) => actual.name === entry.name && actual.value === entry.value), "OWN_ENTRY_ENVIRONMENT_DRIFT");
		capture(workload);
		const serviceMatches = all.Service.filter(object => object.metadata.name === expected.name && owned(object)); assert.equal(serviceMatches.length, 1);
		const service = serviceMatches[0]; assert(service.spec.type === "ClusterIP" && service.spec.ports.length >= 1);
		if (expected.ports.length) assert.deepEqual(service.spec.ports.map((port: Item) => port.port), expected.ports);
		capture(service);
		const pods = all.Pod.filter(object => !object.metadata.deletionTimestamp && Object.entries(service.spec.selector).every(([key, value]) => object.metadata.labels?.[key] === value));
		assert.equal(pods.length, 1);
		const pod = pods[0]; assert(pod.status.phase === "Running" && pod.metadata.labels[ownerLabel] === prefix);
		if (expected.kind === "Deployment") {
			const owner = pod.metadata.ownerReferences?.find((item: Item) => item.kind === "ReplicaSet" && item.controller === true); assert(owner);
			const sets = all.ReplicaSet.filter(object => object.metadata.uid === owner.uid && object.metadata.ownerReferences?.some((item: Item) => item.kind === "Deployment" && item.controller === true && item.uid === workload.metadata.uid));
			assert.equal(sets.length, 1); capture(sets[0]);
		} else assert(pod.metadata.ownerReferences?.some((item: Item) => item.kind === "StatefulSet" && item.controller === true && item.uid === workload.metadata.uid));
		assert(pod.status.containerStatuses.length === expected.images.length && pod.status.containerStatuses.every((status: Item) => status.ready));
		assert.deepEqual(pod.spec.containers.map((container: Item) => container.image.split("@")[1]).sort(), [...expected.images].sort());
		assert.deepEqual(pod.status.containerStatuses.map((status: Item) => status.imageID.split("@")[1]).sort(), [...expected.images].sort());
		capture(pod);
		const endpoints = all.EndpointSlice.filter(object => object.metadata.labels?.["kubernetes.io/service-name"] === expected.name);
		assert(endpoints.length >= 1 && endpoints.every(object => object.metadata.ownerReferences?.some((owner: Item) => owner.uid === service.metadata.uid)));
		assert(endpoints.some(object => object.endpoints?.some((endpoint: Item) => endpoint.conditions?.ready === true && endpoint.targetRef?.uid === pod.metadata.uid && endpoint.addresses?.includes(pod.status.podIP))));
		assert(endpoints.every(object => (object.endpoints ?? []).every((endpoint: Item) => endpoint.conditions?.ready === false ||
			(endpoint.targetRef?.uid === pod.metadata.uid && endpoint.addresses?.length === 1 && endpoint.addresses[0] === pod.status.podIP))), "OWN_ENTRY_UNRELATED_ENDPOINT");
		assert(service.spec.ports.every((port: Item) => endpoints.some(object => object.ports?.some((endpoint: Item) => endpoint.port === port.targetPort))));
		for (const endpoint of endpoints) capture(endpoint);
	}
	const ingressMatches = all.Ingress.filter(object => object.metadata.name === prefix && owned(object)); assert.equal(ingressMatches.length, 1);
	const ingress = ingressMatches[0]; const hostname = new URL(origin).hostname;
	const entry = services.find(service => service.entry)!;
	assert(ingress.spec.tls?.some((tls: Item) => tls.hosts.includes(hostname)));
	const rule = ingress.spec.rules.filter((item: Item) => item.host === hostname); assert.equal(rule.length, 1);
	assert(rule[0].http.paths.some((item: Item) => item.path === "/" && item.backend.service.name === entry.name));
	capture(ingress);
	const revisions = new Set([...all.Deployment, ...all.StatefulSet, ...all.Service, ingress].filter(owned).map(object => object.metadata.labels?.[revisionLabel]));
	assert(revisions.size === 1 && [...revisions].every(value => /^[1-9][0-9]*$/u.test(value)), "OWN_ENTRY_CONFIGURATION_REVISION_DRIFT");
	return { serviceCount: services.length, imageDigests: [...new Set(services.flatMap(service => service.images))], entryDigest: entry.images[0],
		configurationRevision: `workload-${[...revisions][0]}`, resourceIdentityHash: hash(JSON.stringify(identities.map(({ kind, uid }) => ({ kind, uid })).sort((a, b) => a.uid.localeCompare(b.uid)))),
		resources: identities.map(identity => ({ kind: identity.kind, uidHash: hash(identity.uid) })) };
}

export async function browserEntry(origin: string, allowed: string, denied: string, certificateFile: string, expectedReply: string, directory: string) {
	const require = createRequire(new URL("../../apps/web/package.json", import.meta.url));
	const { chromium } = require("@playwright/test");
	// Node verifies the CA, hostname and content first; Chromium pins this exact reviewed leaf public key.
	const certificate = new X509Certificate(await privateBytes(certificateFile));
	const spki = createHash("sha256").update(certificate.publicKey.export({ type: "spki", format: "der" })).digest("base64");
	const browser = await chromium.launch({ headless: true, args: [`--ignore-certificate-errors-spki-list=${spki}`] });
	try {
		const context = await browser.newContext({ ignoreHTTPSErrors: false });
		context.setDefaultTimeout(30_000); context.setDefaultNavigationTimeout(30_000);
		const page = await context.newPage();
		await page.goto(origin, { waitUntil: "domcontentloaded" });
		await page.getByLabel("应用访问凭证").fill(allowed.replace(/^Bearer /u, ""));
		await Promise.all([page.waitForURL(`${origin}/app`), page.getByRole("button", { name: "登录", exact: true }).click()]);
		const cookie = (await context.cookies()).find((item: Item) => item.name === "__Host-custom-entry");
		assert(cookie?.secure && cookie.httpOnly && cookie.sameSite === "Strict" && cookie.path === "/");
		await page.getByRole("heading", { name: "自定义应用", exact: true }).waitFor();
		const response = page.waitForResponse((item: any) => item.url() === `${origin}/api/check` && item.request().method() === "GET");
		await page.getByRole("button", { name: "读取服务状态", exact: true }).click();
		assert.equal((await response).status(), 200);
		await page.waitForFunction((text: string) => document.getElementById("result")?.textContent === text, expectedReply);
		await page.reload({ waitUntil: "domcontentloaded" }); await page.getByRole("heading", { name: "自定义应用", exact: true }).waitFor();
		const screenshot = join(directory, "own-entry.png"); await page.screenshot({ path: screenshot }); await chmod(screenshot, 0o600);
		const other = await browser.newContext({ ignoreHTTPSErrors: false }); const otherPage = await other.newPage();
		other.setDefaultTimeout(30_000); other.setDefaultNavigationTimeout(30_000);
		await otherPage.goto(origin, { waitUntil: "domcontentloaded" }); await otherPage.getByLabel("应用访问凭证").fill(denied.replace(/^Bearer /u, ""));
		const rejected = otherPage.waitForResponse((item: any) => item.url() === `${origin}/auth/login`);
		await otherPage.getByRole("button", { name: "登录", exact: true }).click(); assert.equal((await rejected).status(), 403);
		assert.equal((await other.cookies()).some((item: Item) => item.name === "__Host-custom-entry"), false);
		return { loginVerified: true, renderedApplication: true, backendInteraction: true, reloadVerified: true, deniedLoginVerified: true, tlsLeafPinned: true };
	} finally { await browser.close(); }
}

export function assertOwnEntryUnchanged(before: { resourceIdentityHash: string; configurationRevision: string }, after: { resourceIdentityHash: string; configurationRevision: string }) {
	assert.equal(after.resourceIdentityHash, before.resourceIdentityHash, "OWN_ENTRY_WORKLOAD_CHANGED");
	assert.equal(after.configurationRevision, before.configurationRevision, "OWN_ENTRY_CONFIGURATION_REVISION_CHANGED");
}

export async function validateOwnEntry(configFile: string, requestsFile: string, stateDirectory: string, evidenceDirectory: string, sourceSha: string, read: Read) {
	const config = await privateJson(configFile), requests = await privateJson(requestsFile);
	assert(Object.keys(config).every(key => ["schemaVersion", "requestName", "sourceSha", "routeHostSuffix", "imageSourceSha", "contentSha256", "issuer", "audience", "signingKeyFile", "browserCertificateFile", "expectedReply"].includes(key)));
	assert(config.schemaVersion === 1 && config.sourceSha === sourceSha && /^[a-f0-9]{40}$/u.test(config.imageSourceSha) && /^[a-f0-9]{64}$/u.test(config.contentSha256));
	assert(/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(config.requestName) && [config.issuer, config.audience].every(value => typeof value === "string" && value.length > 0 && value.length <= 256));
	assert(/^[a-z0-9][a-z0-9.-]+$/u.test(config.routeHostSuffix) && typeof config.expectedReply === "string" && config.expectedReply.length <= 256);
	const selected = requests.requests.filter((item: Item) => item.name === config.requestName); assert.equal(selected.length, 1);
	const bodies = await readAgentBindings(requests, stateDirectory, sourceSha);
	const bound = bodies.find(item => item.name === config.requestName)!;
	assert(bound.binding?.ready === true);
	const body = bound.body;
	assert(body.source?.interactionMode === "self-managed" && body.source.identityResponsibility === "self-managed");
	const agentId = bound.binding.agentId;
	const token = await readAuthorization(selected[0].credentialFile);
	const response = await fetch(`${requests.origin}/api/v2/agents/${encodeURIComponent(agentId)}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000), redirect: "error" });
	assert.equal(response.status, 200); const agent = await response.json();
	assert(agent.agentId === agentId && agent.managementStatus === "available" && agent.serviceAvailability === "ready" && agent.source?.interactionMode === "self-managed" && agent.source.identityResponsibility === "self-managed");
	const prefix = `agent-${hash(agentId).slice(0, 32)}`;
	const origin = `https://${prefix}.${config.routeHostSuffix}`;
	assert([origin, `${origin}/`].includes(agent.interactionUrl), "OWN_ENTRY_URL_BINDING_INVALID");
	if (body.source.manifest !== undefined) assert.equal(agent.source.manifest, body.source.manifest);
	else assert.equal(agent.source.imageReference.split("@")[1], body.source.imageReference.split("@")[1]);
	const workload = verifyOwnEntryWorkloads(agentId, body.source, origin, read, body.environment);
	const directory = await mkdtemp(join(evidenceDirectory, "own-entry-"));
	const key = createPrivateKey(await privateBytes(config.signingKeyFile)); assert.equal(key.asymmetricKeyType, "ed25519");
	const jwt = (subject: string, permissions: string[]) => {
		const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url"); const now = Math.floor(Date.now() / 1000);
		const data = `${encode({ alg: "EdDSA", typ: "JWT" })}.${encode({ iss: config.issuer, aud: config.audience, sub: subject, iat: now, exp: now + 1800, permissions })}`;
		return `Bearer ${data}.${sign(null, Buffer.from(data), key).toString("base64url")}`;
	};
	const allowed = jwt("owner", ["web:read"]), denied = jwt("viewer", []);
	const allowedFile = join(directory, "allowed.private"), deniedFile = join(directory, "denied.private");
	await writeFile(allowedFile, allowed, { mode: 0o600 }); await writeFile(deniedFile, denied, { mode: 0o600 });
	const boundary = await verifyCustomAgentWeb({ url: `${origin}/app`, sourceSha: config.imageSourceSha, imageDigest: workload.entryDigest,
		configurationRevision: workload.configurationRevision, contentSha256: config.contentSha256, allowedAuthorizationFile: allowedFile, deniedAuthorizationFile: deniedFile }, { transportRetryTimeoutMs: 120_000 });
	await writeFile(join(directory, "boundary.json"), `${JSON.stringify({ schemaVersion: 1, kind: "ack-own-entry-boundary", sourceSha, agentHash: hash(agentId), boundary }, null, 2)}\n`, { mode: 0o600 });
	assert(boundary.pass, "OWN_ENTRY_BOUNDARY_FAILED");
	const browser = await browserEntry(origin, allowed, denied, config.browserCertificateFile, config.expectedReply, directory);
	const after = verifyOwnEntryWorkloads(agentId, body.source, origin, read, body.environment);
	assertOwnEntryUnchanged(workload, after);
	return { schemaVersion: 1, kind: "ack-self-managed-entry", sourceSha, requestName: config.requestName, agentHash: hash(agentId), originHash: hash(origin),
		serviceCount: workload.serviceCount, imageDigests: workload.imageDigests, resources: workload.resources, boundary, browser, pass: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const [config, requests, state, evidence, source] = process.argv.slice(2);
		assert(process.env.ACK_KUBECONFIG && process.env.ACK_NAMESPACE);
		const read: Read = kind => JSON.parse(execFileSync("kubectl", ["--kubeconfig", process.env.ACK_KUBECONFIG!, "--request-timeout=20s", "-n", process.env.ACK_NAMESPACE!, "get", kind, "-o", "json"],
			{ encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] })).items;
		process.stdout.write(`${JSON.stringify(await validateOwnEntry(config, requests, state, evidence, source, read))}\n`);
	} catch { process.stderr.write("ACK_SELF_MANAGED_ENTRY_FAILED\n"); process.exitCode = 1; }
}
