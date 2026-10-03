import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	CoreV1Api,
	KubeConfig,
	type KubernetesObject,
	type V1NetworkPolicy,
} from "@kubernetes/client-node";
import { expect, it } from "vitest";
import { createWorkerKubernetesClientV1 } from "./kubernetes-client.js";
import {
	createSessionSandboxEgressV1,
	type SessionSandboxEgressBindingV1,
} from "./session-sandbox-egress.js";

const kubeconfig = process.env.SANDBOX_EGRESS_KIND_KUBECONFIG;
const image = process.env.SANDBOX_EGRESS_KIND_IMAGE;
const evidence = process.env.SANDBOX_EGRESS_KIND_EVIDENCE;

// Explicit opt-in only. Synthetic allocation and HTTP endpoints exercise a REAL
// CNI data plane, not the Store/Runtime/external model/Connection acceptance path.
it.skipIf(!kubeconfig || !image || !evidence)(
	"enforces per-Sandbox egress on real kind/CNI Pods",
	async () => {
		if (
			!kubeconfig ||
			!image ||
			!evidence ||
			!/@sha256:[0-9a-f]{64}$/.test(image)
		)
			throw new Error(
				"Explicit kubeconfig, pinned Node image and evidence directory required",
			);
		const namespace = `egress-1255-${Date.now().toString(36)}`;
		const kubectl = (args: string[], input?: object) =>
			execFileSync(
				"kubectl",
				["--kubeconfig", kubeconfig, "--request-timeout=20s", ...args],
				{
					encoding: "utf8",
					timeout: 90_000,
					...(input ? { input: JSON.stringify(input) } : {}),
					stdio: ["pipe", "pipe", "pipe"],
				},
			);
		const create = (object: object) =>
			JSON.parse(
				kubectl(["create", "-f", "-", "-o", "json"], object),
			) as KubernetesObject;
		mkdirSync(evidence, { recursive: true });
		const config = new KubeConfig();
		config.loadFromFile(kubeconfig);
		const core = config.makeApiClient(CoreV1Api);
		const podUids = new Map<string, string>();
		const client = createWorkerKubernetesClientV1(namespace, config);
		const profile = {
			ref: "controlled-cni-probe",
			revision: "1",
			modelEgress: [
				{
					destination: { namespace, podLabels: { endpoint: "model" } },
					port: 8080,
				},
			],
			connectionEgress: [
				{
					destination: { namespace, podLabels: { endpoint: "connection" } },
					port: 8080,
				},
			],
			dnsEgress: [
				{ namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
			],
		};
		const binding = (id: string): SessionSandboxEgressBindingV1 => ({
			schemaVersion: 1,
			principalId: "controlled-test",
			agentId: "same-agent",
			sessionId: `session-${id}`,
			sandboxId: `sandbox-${id}`,
			generation: 1,
			fence: 1,
			configRevision: 1,
			workloadRevision: 1,
			namespace,
			leaseId: "test-only",
			leaseExpiresAt: Date.now() + 600_000,
		});
		const a = binding("a");
		const b = binding("b");
		const adapter = createSessionSandboxEgressV1({
			client,
			profile,
			// The test owns immutable synthetic allocations; production must use the original authority.
			withCurrentAllocation: async (_binding, _operation, action) => action(),
		});
		const outcomes: Record<string, unknown> = {
			namespace,
			image,
			profile,
			allocations: [a, b],
			scope:
				"real CNI; synthetic allocations and endpoints; not production acceptance",
		};
		const probes: { pod: string; host: string; result: string }[] = [];
		outcomes.probes = probes;
		outcomes.sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();
		const fetchFrom = (pod: string, host: string) => {
			const result = kubectl([
				"-n",
				namespace,
				"exec",
				pod,
				"--",
				"node",
				"-e",
				`fetch(${JSON.stringify(`http://${host}:8080`)}, {signal: AbortSignal.timeout(1500)}).then(async r => {if(await r.text() !== 'ok') process.exit(2); console.log('allowed')}).catch(() => console.log('denied'))`,
			]).trim();
			if (result !== "allowed" && result !== "denied")
				throw new Error("Invalid network probe output");
			probes.push({ pod, host, result });
			return result === "allowed";
		};
		async function eventually(check: () => boolean) {
			for (let attempt = 0; attempt < 20; attempt++) {
				if (check()) return;
				await new Promise((resolve) => setTimeout(resolve, 500));
			}
			throw new Error("CNI probe did not reach expected result");
		}
		const createdNamespace = create({
			apiVersion: "v1",
			kind: "Namespace",
			metadata: { name: namespace },
		});
		const namespaceUid = createdNamespace.metadata?.uid;
		if (!namespaceUid) throw new Error("Missing created Namespace UID");
		try {
			const receiptA = await adapter.apply(a);
			const receiptB = await adapter.apply(b);
			for (const name of [
				"model",
				"connection",
				"unapproved",
				"sandbox-a",
				"sandbox-b",
			]) {
				const allocation =
					name === "sandbox-a" ? a : name === "sandbox-b" ? b : undefined;
				const labels = {
					endpoint: name,
					...(allocation
						? {
								"agent-infra.agora.io/agent-id": allocation.agentId,
								"agent-infra.agora.io/session-id": allocation.sessionId,
								"agent-infra.agora.io/sandbox-id": allocation.sandboxId,
								"agent-infra.agora.io/generation": "1",
							}
						: {}),
				};
				const pod = create({
					apiVersion: "v1",
					kind: "Pod",
					metadata: { namespace, name, labels },
					spec: {
						automountServiceAccountToken: false,
						terminationGracePeriodSeconds: 1,
						containers: [
							{
								name: "probe",
								image,
								imagePullPolicy: "IfNotPresent",
								command: [
									"node",
									"-e",
									"require('node:http').createServer((q,r)=>r.end('ok')).listen(8080,'0.0.0.0')",
								],
								securityContext: {
									runAsNonRoot: true,
									runAsUser: 1000,
									allowPrivilegeEscalation: false,
									capabilities: { drop: ["ALL"] },
								},
							},
						],
					},
				});
				if (!pod.metadata?.uid) throw new Error("Missing created Pod UID");
				podUids.set(name, pod.metadata.uid);
				create({
					apiVersion: "v1",
					kind: "Service",
					metadata: { namespace, name },
					spec: {
						selector: { endpoint: name },
						ports: [{ port: 8080, targetPort: 8080 }],
					},
				});
			}
			kubectl([
				"-n",
				namespace,
				"wait",
				"--for=condition=Ready",
				"pod",
				"--all",
				"--timeout=60s",
			]);
			// Prove every negative target is actually serving before testing denial.
			for (const target of [
				"model",
				"connection",
				"unapproved",
				"sandbox-a",
				"sandbox-b",
			]) {
				await eventually(() => fetchFrom("unapproved", target));
			}
			for (const pod of ["sandbox-a", "sandbox-b"]) {
				kubectl([
					"-n",
					namespace,
					"exec",
					pod,
					"--",
					"node",
					"-e",
					"require('node:dns').resolve4('kubernetes.default.svc.cluster.local',(e,a)=>process.exit(e||!a.length?1:0))",
				]);
				for (const target of ["model", "connection"])
					await eventually(() => fetchFrom(pod, target));
				for (const target of [
					"unapproved",
					pod === "sandbox-a" ? "sandbox-b" : "sandbox-a",
				])
					await eventually(() => !fetchFrom(pod, target));
			}
			outcomes.positiveAndNegative =
				"both Sessions: DNS/model/connection allowed; live unapproved/sibling Service denied";
			const live = await client.read<V1NetworkPolicy>(
				"NetworkPolicy",
				receiptA.name,
			);
			if (!live?.spec) throw new Error("Missing policy");
			live.spec.egress = [{}];
			await client.replace(live);
			expect(await adapter.observe(a, receiptA)).toBe(false);
			await adapter.apply(a, receiptA);
			await eventually(() => !fetchFrom("sandbox-a", "unapproved"));
			outcomes.drift =
				"widened policy detected and repaired; real packets denied after repair";
			const modelIP = JSON.parse(
				kubectl(["-n", namespace, "get", "service", "model", "-o", "json"]),
			).spec.clusterIP as string;
			expect(fetchFrom("sandbox-a", modelIP)).toBe(true);
			await adapter.revoke(a, receiptA);
			await eventually(() => !fetchFrom("sandbox-a", modelIP));
			expect(fetchFrom("sandbox-b", "model")).toBe(true);
			outcomes.revocation = "a denied; b still allowed";
			writeFileSync(
				join(evidence, "resources.json"),
				kubectl([
					"-n",
					namespace,
					"get",
					"pods,services,networkpolicies",
					"-o",
					"json",
				]),
			);
			writeFileSync(
				join(evidence, "cni.json"),
				kubectl(["-n", "kube-system", "get", "daemonsets", "-o", "json"]),
			);
			for (const name of ["sandbox-a", "sandbox-b"]) {
				const uid = podUids.get(name);
				if (!uid) throw new Error("Missing owned Pod UID");
				await core.deleteNamespacedPod({
					name,
					namespace,
					body: { preconditions: { uid } },
				});
				kubectl([
					"-n",
					namespace,
					"wait",
					"--for=delete",
					`pod/${name}`,
					"--timeout=60s",
				]);
			}
			await adapter.revoke(b, receiptB);
			await adapter.remove(a, receiptA);
			await adapter.remove(b, receiptB);
			expect(await client.read("NetworkPolicy", receiptA.name)).toBeNull();
			expect(await client.read("NetworkPolicy", receiptB.name)).toBeNull();
			outcomes.cleanupPolicies = "both exact UID policies absent";
		} finally {
			writeFileSync(
				join(evidence, "result.json"),
				JSON.stringify(outcomes, null, 2),
			);
			// Delete only the Namespace UID returned by this invocation's create.
			await core.deleteNamespace({
				name: namespace,
				body: { preconditions: { uid: namespaceUid } },
			});
			kubectl([
				"wait",
				"--for=delete",
				`namespace/${namespace}`,
				"--timeout=60s",
			]);
		}
	},
	240_000,
);
