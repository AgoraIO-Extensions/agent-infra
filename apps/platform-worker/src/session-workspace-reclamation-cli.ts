import { readFileSync } from "node:fs";
import {
	createSessionWorkspaceReclamationV1,
	type SessionWorkspaceReclamationTargetV1,
	type SessionWorkspaceRetentionPolicyV1,
} from "@agent-infra/platform-core";
import { PostgresSessionWorkspaceReclamationStoreV1 } from "@agent-infra/platform-store";
import { KubeConfig } from "@kubernetes/client-node";
import { createWorkerKubernetesClientV1 } from "./kubernetes-client.js";

/** Operator-only entry, deliberately not an HTTP/user or Worker tick capability. */
async function main() {
	const [mode, policyFile, inputFile, ...extra] = process.argv.slice(2);
	if (
		!["dry-run", "execute", "inspect"].includes(mode ?? "") ||
		!policyFile ||
		!inputFile ||
		extra.length !== 0
	)
		throw new Error("WORKSPACE_COMMAND_INVALID");
	const policy = JSON.parse(
		readFileSync(policyFile, "utf8"),
	) as SessionWorkspaceRetentionPolicyV1;
	const input = JSON.parse(readFileSync(inputFile, "utf8"));
	const databaseUrl = process.env.PLATFORM_DATABASE_URL;
	const owner = process.env.DEPLOYMENT_OWNER;
	const kubeconfig = process.env.KUBECONFIG;
	if (!databaseUrl || !owner || !kubeconfig)
		throw new Error("WORKSPACE_OPERATOR_CONTEXT_REQUIRED");
	const config = new KubeConfig();
	config.loadFromFile(kubeconfig);
	const client = createWorkerKubernetesClientV1(policy.namespace, config);
	const store = new PostgresSessionWorkspaceReclamationStoreV1(
		databaseUrl,
		policy,
		owner,
	);
	const usecase = createSessionWorkspaceReclamationV1(store, {
		async read(name) {
			const pvc = await client.read("PersistentVolumeClaim", name);
			if (!pvc) return null;
			const uid = pvc.metadata?.uid;
			const resourceVersion = pvc.metadata?.resourceVersion;
			if (!uid || !resourceVersion)
				throw new Error("WORKSPACE_PVC_IDENTITY_MISSING");
			return { uid, resourceVersion };
		},
		async delete(t) {
			await client.delete({
				apiVersion: "v1",
				kind: "PersistentVolumeClaim",
				metadata: {
					namespace: t.namespace,
					name: t.name,
					uid: t.uid,
					resourceVersion: t.resourceVersion,
				},
			});
		},
	});
	try {
		const result =
			mode === "inspect"
				? await store.inspect(input as SessionWorkspaceReclamationTargetV1)
				: mode === "dry-run"
					? await usecase.dryRun(input)
					: await usecase.execute(input as SessionWorkspaceReclamationTargetV1);
		const inspectedPvc =
			mode === "inspect"
				? await client.read(
						"PersistentVolumeClaim",
						(input as SessionWorkspaceReclamationTargetV1).name,
					)
				: undefined;
		process.stdout.write(
			`${JSON.stringify({ schemaVersion: 1, mode, result, ...(mode === "inspect" ? { pvc: inspectedPvc ? { uid: inspectedPvc.metadata?.uid, resourceVersion: inspectedPvc.metadata?.resourceVersion, deletionTimestamp: inspectedPvc.metadata?.deletionTimestamp } : null } : {}) })}\n`,
		);
	} finally {
		await store.close();
	}
}
main().catch(() => {
	process.stderr.write(
		"WORKSPACE_RECLAMATION_FAILED; preserve target and inspect durable audit before retry\n",
	);
	process.exitCode = 1;
});
