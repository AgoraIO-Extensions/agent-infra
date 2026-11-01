import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const OWNER = "agent-infra.validation-owner";
const SOURCE = "agent-infra.validation-source";
const SCOPE = "agent-infra.validation-scope";
const scope = "isolated-custom-runtime-capacity";
const outputLimit = 1024 * 1024;
const commandTimeoutMs = 45_000;
type Resources = { requests: { cpu: string; memory: string }; limits: { cpu: string; memory: string } };
type Kind = "Pod" | "Secret";
type Document = {
	apiVersion?: string; kind?: string;
	metadata?: { name?: string; namespace?: string; uid?: string; resourceVersion?: string; labels?: Record<string, string>; deletionTimestamp?: string };
	spec?: { containers?: { name?: string; image?: string; resources?: Resources; [key: string]: unknown }[]; nodeName?: string; [key: string]: unknown };
	status?: { phase?: string; conditions?: { type?: string; status?: string }[]; containerStatuses?: { name?: string; imageID?: string; ready?: boolean; restartCount?: number; state?: { running?: unknown; terminated?: unknown; waiting?: { reason?: string } } }[]; nodeInfo?: { architecture?: string; operatingSystem?: string } };
};
export type CustomCapacityResourceRef = { kind: Kind; name: string; uid: string; resourceVersion: string; owner: string };
export type CustomCapacityObservedPod = { pod: Document; uid: string; imageDigest: string; sourceCommit: string; resources: Resources; platform: "linux/amd64"; nodeName: string };
export type CustomCapacityCleanupResult = {
	status: "cleaned" | "failed";
	resources: { kind: Kind; name: string; uid?: string; status: "deleted" | "absent" | "preserved" | "failed"; code?: string }[];
};
export type CustomCapacityKubernetesOptions = {
	kubeconfig: string; namespace: string; owner: string; sourceCommit: string;
	imageReference: string; imageDigest: string; platform: "linux/amd64"; resources: Resources;
	signal: AbortSignal; cleanupTimeoutMs?: number;
	execute?: (args: string[]) => ChildProcessWithoutNullStreams;
};

function fail(code: string): never { throw new Error(`CUSTOM_CAPACITY_${code}`); }
const checkSignal = (signal: AbortSignal) => { if (signal.aborted) fail("ABORTED"); };
const parse = (raw: string): Document => {
	try {
		const value: unknown = JSON.parse(raw);
		if (value && typeof value === "object" && !Array.isArray(value)) return value as Document;
	} catch {}
	return fail("KUBERNETES_RESPONSE_INVALID");
};
const sameResources = (actual: Resources | undefined, expected: Resources) =>
	actual && ["requests", "limits"].every((part) => {
		const key = part as keyof Resources;
		return actual[key] && Object.keys(actual[key]).length === 2 &&
			actual[key].cpu === expected[key].cpu && actual[key].memory === expected[key].memory;
	}) && Object.keys(actual).length === 2;

/** All output stays private: kubectl errors may include a submitted Secret. */
function manage(child: ChildProcessWithoutNullStreams, signal: AbortSignal) {
	let exited = child.exitCode !== null || child.signalCode !== null;
	let exitCode: number | null = child.exitCode;
	let processError = false;
	let resolveExit: () => void = () => {};
	const exit = new Promise<void>((resolve) => { resolveExit = resolve; });
	if (exited) resolveExit();
	child.once("error", () => { processError = true; exited = true; resolveExit(); });
	child.once("close", (code) => { exitCode = code; exited = true; resolveExit(); });
	child.stdin.on("error", () => {});
	let stopping: Promise<void> | undefined;
	const close = () => {
		stopping ??= (async () => {
			if (!exited) child.kill("SIGTERM");
			await Promise.race([exit, delay(500)]);
			if (!exited) child.kill("SIGKILL");
			await Promise.race([exit, delay(500)]);
			signal.removeEventListener("abort", abort);
			if (!exited) fail("PROCESS_DID_NOT_EXIT");
		})();
		return stopping;
	};
	const abort = () => { void close().catch(() => {}); };
	signal.addEventListener("abort", abort, { once: true });
	if (signal.aborted) abort();
	void exit.then(() => signal.removeEventListener("abort", abort));
	return { child, exit, close, alive: () => !exited, ok: () => exited && !processError && exitCode === 0 };
}

export function createCustomCapacityKubernetes(options: CustomCapacityKubernetesOptions) {
	const { namespace, owner, sourceCommit, signal } = options;
	const namePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
	if (!isAbsolute(options.kubeconfig) || !namePattern.test(namespace) ||
		!/^[a-z0-9-]{16,63}$/u.test(owner) || !/^[a-f0-9]{40}$/u.test(sourceCommit) ||
		options.platform !== "linux/amd64" || !/^sha256:[a-f0-9]{64}$/u.test(options.imageDigest) ||
		!options.imageReference.endsWith(`@${options.imageDigest}`)) fail("KUBERNETES_OPTIONS_INVALID");
	const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 30_000;
	if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 120_000) fail("CLEANUP_BUDGET_INVALID");
	const execute = options.execute ?? ((args: string[]) => spawn("kubectl", args, { stdio: ["pipe", "pipe", "pipe"] }));
	const base = ["--kubeconfig", options.kubeconfig, "--namespace", namespace, "--request-timeout=40s"];
	const attempted = new Map<string, { kind: Kind; name: string; ref?: CustomCapacityResourceRef }>();
	const forwards = new Set<Awaited<ReturnType<typeof startServer>>>();
	const keyOf = (kind: Kind, name: string) => `${kind}/${name}`;
	let cleaning = false;
	let cleanupResult: Promise<CustomCapacityCleanupResult> | undefined;

	async function command(args: string[], currentSignal: AbortSignal, input?: string) {
		checkSignal(currentSignal);
		const bounded = AbortSignal.any([currentSignal, AbortSignal.timeout(commandTimeoutMs)]);
		const process = manage(execute([...base, ...args]), bounded);
		const stdout: Buffer[] = [];
		let bytes = 0;
		let overflow = false;
		const collect = (chunk: Buffer, output: boolean) => {
			bytes += chunk.length;
			if (bytes > outputLimit) { overflow = true; void process.close().catch(() => {}); }
			else if (output) stdout.push(chunk);
		};
		process.child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
		process.child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
		process.child.stdin.end(input);
		let onAbort: () => void = () => {};
		const aborted = new Promise<void>((resolve) => { onAbort = resolve; });
		bounded.addEventListener("abort", onAbort, { once: true });
		if (bounded.aborted) onAbort();
		try {
			await Promise.race([process.exit, aborted]);
			if (bounded.aborted) fail("COMMAND_ABORTED");
			if (overflow) fail("COMMAND_OUTPUT_LIMIT");
			if (!process.ok()) fail("COMMAND_FAILED");
			return Buffer.concat(stdout).toString("utf8");
		} finally { bounded.removeEventListener("abort", onAbort); await process.close(); }
	}

	async function get(kind: Kind | "Node", name: string, currentSignal: AbortSignal) {
		const raw = await command(["get", kind.toLowerCase(), name, "--ignore-not-found", "-o", "json"], currentSignal);
		return raw.trim() ? parse(raw) : undefined;
	}
	function owned(document: Document, kind: Kind, name: string) {
		const meta = document.metadata;
		return document.kind === kind && meta?.name === name && meta.namespace === namespace &&
			meta.labels?.[OWNER] === owner && meta.labels?.[SOURCE] === sourceCommit && meta.labels?.[SCOPE] === scope;
	}
	function capture(document: Document, kind: Kind, name: string): CustomCapacityResourceRef {
		if (!owned(document, kind, name) || !document.metadata?.uid || !document.metadata.resourceVersion) fail("RESOURCE_BINDING_MISMATCH");
		return { kind, name, uid: document.metadata.uid, resourceVersion: document.metadata.resourceVersion, owner };
	}
	function checkRef(ref: CustomCapacityResourceRef) {
		if (!["Pod", "Secret"].includes(ref.kind) || !namePattern.test(ref.name) || !ref.uid || !ref.resourceVersion || ref.owner !== owner) fail("RESOURCE_REF_INVALID");
	}
	function checkIdentity(document: Document, ref: CustomCapacityResourceRef) {
		checkRef(ref);
		if (capture(document, ref.kind, ref.name).uid !== ref.uid) fail("RESOURCE_UID_CHANGED");
		if (document.metadata?.deletionTimestamp) fail("RESOURCE_TERMINATING");
	}
	async function create(kind: Kind, input: unknown) {
		if (cleaning) fail("CLEANUP_ALREADY_STARTED");
		const manifest = input as Document;
		const name = manifest?.metadata?.name;
		if (!name || !namePattern.test(name) || !owned(manifest, kind, name) || manifest.apiVersion !== "v1") fail("MANIFEST_BINDING_INVALID");
		if (await get(kind, name, signal)) fail("RESOURCE_ALREADY_EXISTS");
		checkSignal(signal);
		if (cleaning) fail("CLEANUP_ALREADY_STARTED");
		const attempt = { kind, name, ref: undefined as CustomCapacityResourceRef | undefined };
		attempted.set(keyOf(kind, name), attempt);
		// Register before sending: an interrupted create may have persisted even without a response.
		const response = await command(["create", "-f", "-", "-o", "json"], signal, JSON.stringify(input));
		const ref = capture(parse(response), kind, name);
		attempt.ref = ref;
		checkSignal(signal);
		return ref;
	}

	async function observe(ref: CustomCapacityResourceRef): Promise<CustomCapacityObservedPod> {
		if (ref.kind !== "Pod") fail("POD_REF_REQUIRED");
		const pod = await get("Pod", ref.name, signal);
		if (!pod) fail("POD_MISSING");
		checkIdentity(pod, ref);
		const runtime = pod.spec?.containers?.find((container) => container.name === "runtime");
		const status = pod.status?.containerStatuses?.find((container) => container.name === "runtime");
		const imageId = status?.imageID?.replace(/^[a-z0-9-]+:\/\//u, "");
		const actualDigest = imageId?.includes("@") ? imageId.slice(imageId.lastIndexOf("@") + 1) : imageId;
		if (pod.spec?.containers?.length !== 1 || runtime?.image !== options.imageReference ||
			actualDigest !== options.imageDigest || !sameResources(runtime?.resources, options.resources) ||
			!status?.ready || !status.state?.running || status.restartCount !== 0 || pod.status?.phase !== "Running" ||
			!pod.status.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True")) fail("POD_OBSERVATION_MISMATCH");
		const nodeName = pod.spec.nodeName;
		if (!nodeName) fail("NODE_MISSING");
		const node = await get("Node", nodeName, signal);
		if (node?.metadata?.name !== nodeName || node.status?.nodeInfo?.architecture !== "amd64" ||
			node.status.nodeInfo.operatingSystem !== "linux" ||
			(node.metadata.labels?.["kubernetes.io/arch"] !== undefined && node.metadata.labels["kubernetes.io/arch"] !== "amd64")) fail("NODE_PLATFORM_MISMATCH");
		checkSignal(signal);
		return { pod, uid: pod.metadata!.uid!, imageDigest: actualDigest!, sourceCommit: pod.metadata!.labels![SOURCE]!, resources: runtime!.resources!, platform: "linux/amd64", nodeName };
	}
	async function waitReady(ref: CustomCapacityResourceRef) {
		checkRef(ref);
		if (ref.kind !== "Pod") fail("POD_REF_REQUIRED");
		const bounded = AbortSignal.any([signal, AbortSignal.timeout(900_000)]);
		while (true) {
			const pod = await get("Pod", ref.name, bounded);
			if (!pod) fail("POD_MISSING");
			checkIdentity(pod, ref);
			if (pod.status?.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True")) return observe(ref);
			if (["Failed", "Succeeded"].includes(pod.status?.phase ?? "") || pod.status?.containerStatuses?.some((container) => container.state?.terminated)) fail("POD_STARTUP_FAILED");
			await delay(250, undefined, { signal: bounded });
		}
	}
	async function execInPod(ref: CustomCapacityResourceRef, args: string[]) {
		await observe(ref);
		if (args.length === 0 || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) fail("EXEC_ARGUMENTS_INVALID");
		const output = await command(["exec", ref.name, "--container", "runtime", "--", ...args], signal);
		await observe(ref);
		return output;
	}

	async function startServer(args: string[], pattern: RegExp, currentSignal: AbortSignal) {
		checkSignal(currentSignal);
		const process = manage(execute([...base, ...args]), currentSignal);
		process.child.stdin.end();
		let output = "";
		let bytes = 0;
		let overflow = false;
		for (const stream of [process.child.stdout, process.child.stderr]) stream.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > outputLimit) { overflow = true; void process.close().catch(() => {}); }
			else output += chunk.toString("utf8");
		});
		const startup = AbortSignal.any([currentSignal, AbortSignal.timeout(10_000)]);
		try {
			while (true) {
				checkSignal(startup);
				if (overflow) fail("SERVER_OUTPUT_LIMIT");
				if (!process.alive()) fail("SERVER_EXITED");
				const match = pattern.exec(output);
				if (match) {
					const port = Number(match[1]);
					if (!Number.isSafeInteger(port) || port < 1 || port > 65535) fail("SERVER_PORT_INVALID");
					let closing: Promise<void> | undefined;
					return { baseUrl: `http://127.0.0.1:${port}`, alive: process.alive, close: () => {
						closing ??= (async () => {
							const failed = overflow || (!process.alive() && !currentSignal.aborted);
							await process.close();
							if (failed) fail("SERVER_EXITED");
						})();
						return closing;
					} };
				}
				await delay(20, undefined, { signal: startup });
			}
		} catch (error) { await process.close(); throw error; }
	}
	async function forward(ref: CustomCapacityResourceRef) {
		await observe(ref);
		const server = await startServer(["port-forward", "--address", "127.0.0.1", `pod/${ref.name}`, ":3003"], /Forwarding from 127\.0\.0\.1:(\d+) -> 3003/u, signal);
		forwards.add(server);
		try {
			await observe(ref);
			if (!server.alive()) fail("SERVER_EXITED");
			return { baseUrl: server.baseUrl, close: async () => { await server.close(); forwards.delete(server); } };
		} catch (error) { await server.close(); forwards.delete(server); throw error; }
	}

	async function performCleanup(refs: readonly CustomCapacityResourceRef[]): Promise<CustomCapacityCleanupResult> {
		cleaning = true;
		const budget = AbortSignal.timeout(cleanupTimeoutMs);
		const results: CustomCapacityCleanupResult["resources"] = [];
		let processFailed = false;
		for (const server of forwards) { try { await server.close(); } catch { processFailed = true; } }
		forwards.clear();
		for (const ref of refs) {
			try {
				checkRef(ref);
				const key = keyOf(ref.kind, ref.name);
				const known = attempted.get(key);
				if (!known || (known.ref && known.ref.uid !== ref.uid)) fail("CLEANUP_REF_CONFLICT");
				attempted.set(key, { kind: ref.kind, name: ref.name, ref });
			} catch {
				results.push({ kind: ref.kind, name: ref.name, uid: ref.uid, status: "failed", code: "CUSTOM_CAPACITY_CLEANUP_REF_INVALID" });
			}
		}
		let proxy: Awaited<ReturnType<typeof startServer>> | undefined;
		try {
			for (const item of [...attempted.values()].sort((a, b) => a.kind === b.kind ? 0 : a.kind === "Pod" ? -1 : 1)) {
				try {
					let current = await get(item.kind, item.name, budget);
					// An unacknowledged create may commit after its client exits; absence is not proof of failure.
					while (!current && !item.ref) {
						await delay(100, undefined, { signal: budget });
						current = await get(item.kind, item.name, budget);
					}
					if (!current) { results.push({ kind: item.kind, name: item.name, uid: item.ref?.uid, status: "absent" }); continue; }
					if (!owned(current, item.kind, item.name) || (item.ref && current.metadata?.uid !== item.ref.uid)) {
						results.push({ kind: item.kind, name: item.name, uid: item.ref?.uid, status: "preserved", code: "CUSTOM_CAPACITY_CLEANUP_BINDING_CHANGED" }); continue;
					}
					const ref = capture(current, item.kind, item.name);
					proxy ??= await startServer(["proxy", "--address=127.0.0.1", "--port=0", "--accept-hosts=^127\\.0\\.0\\.1$"], /Starting to serve on 127\.0\.0\.1:(\d+)/u, budget);
					if (!proxy.alive()) fail("CLEANUP_PROXY_EXITED");
					const response = await fetch(`${proxy.baseUrl}/api/v1/namespaces/${encodeURIComponent(namespace)}/${item.kind === "Pod" ? "pods" : "secrets"}/${encodeURIComponent(item.name)}`, {
						method: "DELETE", headers: { "content-type": "application/json" }, signal: budget, redirect: "error",
						body: JSON.stringify({ apiVersion: "v1", kind: "DeleteOptions", preconditions: { uid: ref.uid, resourceVersion: ref.resourceVersion }, propagationPolicy: "Background", gracePeriodSeconds: 0 }),
					});
					await response.body?.cancel();
					if (!response.ok && response.status !== 404) fail("DELETE_REJECTED");
					while (true) {
						const after = await get(item.kind, item.name, budget);
						if (!after || after.metadata?.uid !== ref.uid) break;
						if (!owned(after, item.kind, item.name)) fail("CLEANUP_BINDING_CHANGED");
						await delay(100, undefined, { signal: budget });
					}
					results.push({ kind: item.kind, name: item.name, uid: ref.uid, status: "deleted" });
				} catch {
					results.push({ kind: item.kind, name: item.name, uid: item.ref?.uid, status: "failed", code: budget.aborted ? "CUSTOM_CAPACITY_CLEANUP_TIMEOUT" : "CUSTOM_CAPACITY_CLEANUP_FAILED" });
				}
			}
		} finally { try { await proxy?.close(); } catch { processFailed = true; } }
		return { status: !processFailed && results.every((result) => ["deleted", "absent"].includes(result.status)) ? "cleaned" : "failed", resources: results };
	}
	return {
		createSecret: (manifest: unknown) => create("Secret", manifest),
		createPod: (manifest: unknown) => create("Pod", manifest), waitReady, observe, forward, execInPod,
		cleanup: (refs: readonly CustomCapacityResourceRef[] = []) => { cleanupResult ??= performCleanup(refs); return cleanupResult; },
	};
}
