import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const [context, image] = process.argv.slice(2);
if (process.argv.length !== 4 || !context || !/^[\w./:-]+@sha256:[a-f0-9]{64}$/.test(image ?? ""))
	throw new Error("Usage: node deploy/verify-connection-network-policy.mjs <context> <Node-runtime-image@sha256:digest>");
const namespace = `connection-egress-probe-${randomUUID().slice(0, 8)}`;
const record = { namespace, context, enforced: false };
let created = false;
let phase = "namespace";
function kubectl(args, input) {
	const result = spawnSync("kubectl", ["--context", context, ...args], { input, encoding: "utf8", timeout: 70_000 });
	if (result.status !== 0) throw new Error(`Network policy validation failed at ${phase}`);
	return result.stdout.trim();
}
function apply(object) { return kubectl(["apply", "-f", "-"], JSON.stringify(object)); }
try {
	kubectl(["create", "namespace", namespace]);
	created = true;
	phase = "pods";
	for (const role of ["server", "client"]) apply({
		apiVersion: "v1", kind: "Pod", metadata: { namespace, name: role, labels: { role } },
		spec: {
			automountServiceAccountToken: false,
			containers: [{
				name: "probe", image, imagePullPolicy: "IfNotPresent",
				command: ["node", "-e", role === "server" ? "require('node:http').createServer((q,s)=>s.end('allowed')).listen(3000,'0.0.0.0')" : "setInterval(()=>{},60000)"],
				resources: { requests: { cpu: "10m", memory: "32Mi" }, limits: { cpu: "100m", memory: "100Mi" } },
				securityContext: { runAsUser: 1000, runAsNonRoot: true, allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] }, seccompProfile: { type: "RuntimeDefault" } },
			}],
		},
	});
	kubectl(["-n", namespace, "wait", "--for=condition=Ready", "pod/server", "pod/client", "--timeout=60s"]);
	const ip = kubectl(["-n", namespace, "get", "pod", "server", "-o", "jsonpath={.status.podIP}"]);
	const probe = () => kubectl(["-n", namespace, "exec", "client", "--", "node", "-e",
		`const s=require('node:net').connect({host:${JSON.stringify(ip)},port:3000});let done=false;const finish=x=>{if(done)return;done=true;console.log(x);s.destroy()};s.setTimeout(2500,()=>finish('BLOCKED'));s.once('connect',()=>finish('REACHABLE'));s.once('error',()=>finish('BLOCKED'));`]);
	phase = "baseline";
	record.baseline = probe();
	phase = "deny";
	apply({ apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { namespace, name: "deny-client-egress" }, spec: { podSelector: { matchLabels: { role: "client" } }, policyTypes: ["Egress"], egress: [] } });
	await new Promise((resolve) => setTimeout(resolve, 5_000));
	record.denied = probe();
	record.secondDenied = probe();
	phase = "allow";
	apply({ apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { namespace, name: "allow-server" }, spec: { podSelector: { matchLabels: { role: "client" } }, policyTypes: ["Egress"], egress: [{ to: [{ podSelector: { matchLabels: { role: "server" } } }], ports: [{ protocol: "TCP", port: 3000 }] }] } });
	await new Promise((resolve) => setTimeout(resolve, 5_000));
	record.allowed = probe();
	record.enforced = record.baseline === "REACHABLE" && record.denied === "BLOCKED" && record.secondDenied === "BLOCKED" && record.allowed === "REACHABLE";
} catch {
	record.error = `Network policy validation failed at ${phase}`;
} finally {
	if (created) {
		phase = "cleanup";
		try { kubectl(["delete", "namespace", namespace, "--wait=false"]); }
		catch { record.cleanupFailed = true; record.enforced = false; }
	}
	console.log(JSON.stringify(record));
	if (!record.enforced) process.exitCode = 1;
}
