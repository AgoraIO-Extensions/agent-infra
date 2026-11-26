import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

type WorkerPodSpec = {
	containers: {
		name: string;
		image: string;
		env?: { name: string; value?: string; valueFrom?: unknown }[];
		envFrom?: unknown[];
	}[];
};

interface WorkerResource {
	kind: "Pod" | "Deployment" | "ReplicaSet";
	spec: WorkerPodSpec & {
		replicas?: number;
		template?: { spec: WorkerPodSpec };
	};
	status?: { phase?: string; replicas?: number };
}

export function activeWorkerSpecs(items: WorkerResource[]) {
	return items
		.filter((item) =>
			item.kind === "Pod"
				? !["Failed", "Succeeded"].includes(item.status?.phase ?? "")
				: item.kind === "Deployment" ||
					item.spec.replicas !== 0 ||
					(item.status?.replicas ?? 0) > 0,
		)
		.map((item) =>
			item.kind === "Pod" ? item.spec : item.spec.template?.spec,
		);
}

/** Read both desired and still-running Worker bindings before a direct job creates resources. */
export function activeCodexTrialImage(
	namespace: string,
	kubeconfig: string,
): string | undefined {
	if (namespace !== "ack-community-m1-4405") return undefined;
	const bytes = execFileSync(
		"kubectl",
		[
			"--kubeconfig",
			kubeconfig,
			"-n",
			namespace,
			"get",
			"pods,deployments,replicasets",
			"-l",
			"app.kubernetes.io/component=platform-worker",
			"--request-timeout=15s",
			"-o",
			"json",
		],
		{ encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] },
	);
	const { items } = JSON.parse(bytes);
	assert(Array.isArray(items), "PREFLIGHT_TRIAL_WORKER_INVALID");
	const images = new Set<string | undefined>();
	for (const spec of activeWorkerSpecs(items)) {
		const workers = spec?.containers.filter(
			(c) => c.name === "platform-worker",
		);
		assert(
			workers?.length === 1 && !workers[0].envFrom?.length,
			"PREFLIGHT_TRIAL_WORKER_INVALID",
		);
		const env =
			workers[0].env?.filter(
				(e) => e.name === "AGENT_INFRA_SIG_CORE_SDK_TRIAL_IMAGE",
			) ?? [];
		if (!env.length) {
			images.add(undefined);
			continue;
		}
		assert(
			env.length === 1 &&
				!env[0].valueFrom &&
				env[0].value &&
				/^ghcr\.io\/agoraio-extensions\/agent-infra\/agent-runtime-codex@sha256:[a-f0-9]{64}$/.test(
					env[0].value,
				),
			"PREFLIGHT_TRIAL_WORKER_INVALID",
		);
		images.add(env[0].value);
	}
	assert(images.size <= 1, "PREFLIGHT_TRIAL_WORKER_INVALID");
	return images.values().next().value;
}
