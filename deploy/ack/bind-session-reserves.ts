import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { readAgentBindings } from "./agent-bindings.ts";
import { privateBytes, privateJson } from "./private-input.ts";
import { parseInput } from "./provision-agents.ts";
import { parseReserveInput, readReserveApi } from "./session-reserve-inputs.ts";
import { sessionSandboxReserveDigestV1 } from "../../packages/platform-core/src/session-sandbox-reserves.ts";

type Json = Record<string, any>;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

/** A deployment-approved policy refers to request names until the API creates the Agents. */
export async function readReservePlan(environment: Record<string, string>, sourceSha: string) {
	const plan = await privateJson(environment.ACK_SESSION_RESERVE_PLAN_FILE);
	const requests = parseInput(await privateJson(environment.ACK_AGENT_REQUESTS_FILE));
	const images = await privateJson(environment.ACK_TEMPLATE_IMAGE_MANIFEST);
	assert(images.schemaVersion === 1 && images.commitSha === sourceSha && images.platform === "linux/amd64", "ACK_RESERVE_PLAN_SOURCE_INVALID");
	assert(plan.enabled === true && Array.isArray(plan.profiles) && plan.profiles.length >= 1 && plan.profiles.length <= 4, "ACK_RESERVE_PLAN_INVALID");
	const names = new Set<string>();
	const profiles = [];
	for (const profile of plan.profiles) {
		const { requestName, ...approved } = profile;
		assert(typeof requestName === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(requestName) && !names.has(requestName) && !("agentId" in profile), "ACK_RESERVE_PLAN_BINDING_INVALID");
		names.add(requestName);
		const matches = requests.requests.filter(r => r.name === requestName);
		assert(matches.length === 1, "ACK_RESERVE_PLAN_BINDING_INVALID");
		const body = await privateJson(matches[0].bodyFile);
		assert(body.source?.kind === "standard" && ["codex", "claude", "opencode", "pi"].includes(approved.templateId) && body.source.templateId === approved.templateId && images.images?.[approved.templateId]?.digest === approved.imageDigest && approved.minimum >= 1, "ACK_RESERVE_PLAN_TEMPLATE_INVALID");
		profiles.push({ ...approved, agentId: requestName });
	}
	const parsed = parseReserveInput({ ...plan, profiles }, sourceSha, environment.ACK_NAMESPACE);
	assert(parsed.profiles.reduce((sum, p) => sum + p.minimum, 0) <= parsed.maximumReserves, "ACK_RESERVE_PLAN_BUDGET_INVALID");
	for (const key of ["cpuMillis", "memoryBytes", "storageBytes"] as const) {
		const minimum = parsed.profiles.reduce((sum, p) => sum + p.minimum * p.resources[key], 0);
		assert(Number.isSafeInteger(minimum) && minimum <= parsed.totalBudget[key], "ACK_RESERVE_PLAN_BUDGET_INVALID");
	}
	return { plan, requests };
}

export async function resolveReserveConfiguration(environment: Record<string, string>, sourceSha: string) {
	const { plan, requests } = await readReservePlan(environment, sourceSha);
	const bindings = await readAgentBindings(requests, environment.ACK_AGENT_STATE_DIR, sourceSha);
	const profiles = plan.profiles.map(({ requestName, ...approved }: Json) => {
		const selected = bindings.find(r => r.name === requestName);
		assert(selected?.binding?.ready === true && typeof selected.binding.agentId === "string" && selected.binding.agentId.length > 0 && selected.binding.agentId.length <= 256, "ACK_RESERVE_AGENT_NOT_READY");
		return { ...approved, agentId: selected.binding.agentId };
	});
	return { ...plan, profiles };
}

export async function bindSessionReserves(environment: Record<string, string>, sourceSha: string) {
	assert(environment.ACK_SESSION_RESERVE_PLAN_FILE !== environment.ACK_SESSION_RESERVES_FILE, "ACK_RESERVE_OUTPUT_ALIAS");
	const candidate = await resolveReserveConfiguration(environment, sourceSha);
	const configuration = parseReserveInput(candidate, sourceSha, environment.ACK_NAMESPACE);
	const file = environment.ACK_SESSION_RESERVES_FILE;
	const before = await privateBytes(file);
	const previous = parseReserveInput(JSON.parse(before.toString("utf8")), sourceSha, environment.ACK_NAMESPACE);
	const configHash = sessionSandboxReserveDigestV1(candidate);
	assert(configuration.revision > previous.revision || (configuration.revision === previous.revision && sessionSandboxReserveDigestV1(configuration) === sessionSandboxReserveDigestV1(previous)), "ACK_RESERVE_REVISION_CONFLICT");
	const changed = sessionSandboxReserveDigestV1(configuration) !== sessionSandboxReserveDigestV1(previous);
	if (changed) {
		const temporary = `${file}.bound-${randomUUID()}`;
		try {
			await writeFile(temporary, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600, flag: "wx" });
			assert((await privateBytes(file)).equals(before), "ACK_RESERVE_LOCAL_DRIFT");
			await rename(temporary, file);
		} finally { await unlink(temporary).catch(() => undefined); }
	}
	return { sourceSha, revision: configuration.revision, profileCount: configuration.profiles.length, configHash, changed, businessVerified: false };
}

export async function waitForReserveMinimum(configuration: Json, inspect: () => Promise<Json>, options: { timeoutMs?: number; now?: () => number; wait?: () => Promise<void> } = {}) {
	const now = options.now ?? Date.now;
	const timeoutMs = options.timeoutMs ?? 600_000;
	assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 900_000, "ACK_RESERVE_WAIT_INVALID");
	const configHash = sessionSandboxReserveDigestV1(configuration);
	const deadline = now() + timeoutMs;
	for (;;) {
		assert(now() < deadline, "ACK_RESERVE_MINIMUM_NOT_READY");
		const actual = await inspect();
		assert(now() < deadline, "ACK_RESERVE_MINIMUM_NOT_READY");
		assert(actual.sourceSha === configuration.sourceSha && actual.configHash === configHash && actual.counts, "ACK_RESERVE_READY_CONFIGURATION_DRIFT");
		assert(configuration.profiles.every((p: Json) => Number.isSafeInteger(actual.counts[p.agentId]) && actual.counts[p.agentId] >= 0), "ACK_RESERVE_READY_COUNTS_INVALID");
		if (configuration.profiles.every((p: Json) => actual.counts[p.agentId] >= p.minimum)) return {
			sourceSha: configuration.sourceSha, configHash, ready: true,
			profiles: configuration.profiles.map((p: Json) => ({ agentHash: hash(p.agentId), minimum: p.minimum, ready: actual.counts[p.agentId] })),
			businessVerified: false,
		};
		await (options.wait ?? (() => new Promise(resolve => setTimeout(resolve, Math.min(2000, Math.max(0, deadline - now()))))))();
	}
}

async function waitForMountedReserves(environment: Record<string, string>, sourceSha: string) {
	const bootstrap = await privateJson(environment.ACK_BOOTSTRAP_INPUTS_FILE);
	const configuration = await privateJson(environment.ACK_SESSION_RESERVES_FILE);
	parseReserveInput(configuration, sourceSha, environment.ACK_NAMESPACE);
	assert(configuration.enabled && configuration.profiles.length > 0, "ACK_RESERVE_PLAN_INVALID");
	const apis = bootstrap.objects.filter((o: Json) => o.kind === "Secret" && o.name.endsWith("-api-configuration"));
	assert(apis.length === 1, "ACK_RESERVE_API_BINDING_INVALID");
	const verify = () => {
		const actual = readReserveApi(environment, bootstrap, apis[0].name);
		assert(actual?.configurationHash === sessionSandboxReserveDigestV1(configuration), "ACK_RESERVE_READY_CONFIGURATION_DRIFT");
	};
	verify();
	const kube = (args: string[], input?: string) => execFileSync("kubectl", ["--kubeconfig", environment.ACK_KUBECONFIG, "--request-timeout=20s", "-n", environment.ACK_NAMESPACE, ...args], { input, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
	const namespaceUid = JSON.parse(kube(["get", "namespace", environment.ACK_NAMESPACE, "-o", "json"])).metadata.uid;
	const pods = JSON.parse(kube(["get", "pods", "-l", "app.kubernetes.io/component=platform-api", "-o", "json"])).items;
	const pod = pods.find((p: Json) => !p.metadata.deletionTimestamp && p.status?.containerStatuses?.every((c: Json) => c.ready));
	assert(pod, "ACK_RESERVE_API_BINDING_INVALID");
	// inspect() is the existing read-only Store contract; a stale profile is never counted as ready.
	const script = `const entry=await import(process.env.PLATFORM_API_DEPLOYMENT_MODULE);const actual=entry.readPlatformSessionReserveDeploymentV1();const {PostgresSessionSandboxReserveStoreV1}=await import('@agent-infra/platform-store');const store=new PostgresSessionSandboxReserveStoreV1({databaseUrl:process.env.PLATFORM_DATABASE_URL,configuration:actual.configuration});try{const counts=Object.fromEntries(actual.configuration.profiles.map(p=>[p.agentId,0]));for(const row of await store.list()){if(row.status!=='ready'||!Object.hasOwn(counts,row.agentId))continue;const r=await store.inspect(row.sandboxId);if(r?.status==='ready'&&r.currentProfileDigest===r.profile.digest)counts[row.agentId]++;}console.log(JSON.stringify({sourceSha:actual.sourceSha,configHash:actual.configurationHash,counts}));}finally{await store.close();process.exit(0);}`;
	const result = await waitForReserveMinimum(configuration, async () => JSON.parse(kube(["exec", "-i", pod.metadata.name, "--", "node", "--input-type=module", "-"], script)));
	const currentPod = JSON.parse(kube(["get", "pod", pod.metadata.name, "-o", "json"]));
	assert(currentPod.metadata.uid === pod.metadata.uid && !currentPod.metadata.deletionTimestamp && JSON.parse(kube(["get", "namespace", environment.ACK_NAMESPACE, "-o", "json"])).metadata.uid === namespaceUid, "ACK_RESERVE_READY_CONFIGURATION_DRIFT");
	verify();
	return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const environment = process.env as Record<string, string>;
		const source = environment.ACK_SOURCE_SHA;
		assert(/^[a-f0-9]{40}$/u.test(source) && ["check", "bind", "wait"].includes(process.argv[2]));
		const result = process.argv[2] === "check" ? { sourceSha: source, profileCount: (await readReservePlan(environment, source)).plan.profiles.length, businessVerified: false }
			: process.argv[2] === "bind" ? await bindSessionReserves(environment, source) : await waitForMountedReserves(environment, source);
		process.stdout.write(`${JSON.stringify(result)}\n`);
	} catch (error) {
		const code = error instanceof Error && /^ACK_RESERVE_[A-Z_]+$/u.test(error.message) ? error.message : "ACK_RESERVE_CONFIGURATION_INVALID";
		process.stderr.write(`${code}\n`); process.exitCode = 1;
	}
}
