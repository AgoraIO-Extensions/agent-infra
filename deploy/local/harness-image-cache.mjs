import { createHash } from "node:crypto";

export function workerInputHash(entries) {
	const hash = createHash("sha256");
	for (const entry of [...entries].sort((a, b) =>
		a.path.localeCompare(b.path),
	)) {
		hash.update(entry.path);
		hash.update("\0");
		hash.update(entry.content);
		hash.update("\0");
	}
	return hash.digest("hex");
}

export function cachedWorkerDigest(cache, inputHash) {
	const entry = cache?.worker?.[inputHash];
	if (!entry?.repository || !/^sha256:[a-f0-9]{64}$/.test(entry.digest))
		return null;
	return entry;
}

export function componentWorkspacePaths(workspaces, rootPath) {
	const byName = new Map(
		workspaces.map((entry) => [entry.manifest.name, entry]),
	);
	const root = workspaces.find((entry) => entry.path === rootPath);
	if (!root) throw new Error(`Unknown workspace: ${rootPath}`);
	const visited = new Set();
	function visit(entry) {
		if (visited.has(entry.path)) return;
		visited.add(entry.path);
		const dependencies = {
			...entry.manifest.dependencies,
			...entry.manifest.devDependencies,
			...entry.manifest.optionalDependencies,
			...entry.manifest.peerDependencies,
		};
		for (const [name, version] of Object.entries(dependencies)) {
			const target = byName.get(name);
			if (target) visit(target);
			else if (String(version).startsWith("workspace:"))
				throw new Error(`Missing workspace dependency: ${name}`);
		}
	}
	visit(root);
	return [...visited].sort();
}

export function assertWorkerReadback(binding, deployments, pods) {
	const expected = `${binding.repository}@${binding.digest}`;
	const deployment = deployments.length === 1 && deployments[0];
	const container = deployment?.spec?.template?.spec?.containers?.find(
		(item) => item.name === "platform-worker",
	);
	const statuses = pods
		.filter((pod) => !pod.metadata?.deletionTimestamp)
		.map((pod) =>
		pod.status?.containerStatuses?.find(
			(item) => item.name === "platform-worker",
		),
	);
	if (
		container?.image !== expected ||
		!(deployment.spec.replicas > 0) ||
		statuses.filter(
			(item) => item?.ready && item.imageID?.endsWith(`@${binding.digest}`),
		).length < deployment.spec.replicas
	) {
		throw new Error("Worker image readback mismatch or rollout incomplete");
	}
}
