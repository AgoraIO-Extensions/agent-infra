import type { OperationsResourceSnapshotV2 as OperationsResourcesV2 } from "./operations-types.js";

type Alert = OperationsResourcesV2["alerts"][number];
export interface OperationsAlertThresholdsV2 {
	readonly capacityRatio: number;
	readonly criticalRatio: number;
	readonly queueCount: number;
}
export const defaultOperationsAlertThresholdsV2: OperationsAlertThresholdsV2 = {
	capacityRatio: 0.9,
	criticalRatio: 0.95,
	queueCount: 100,
};

/** A stopped collector cannot publish its own failure; freshness is derived from its last observation. */
export function projectOperationsStalenessV2(
	snapshot: OperationsResourcesV2,
	now: string,
): OperationsResourcesV2 {
	const staleAfterMs = Math.max(90_000, snapshot.refreshSeconds * 3000);
	const alerts = [...snapshot.alerts];
	const sources = snapshot.sources.map((source) => {
		if (
			source.state !== "available" ||
			!source.observedAt ||
			Date.parse(now) - Date.parse(source.observedAt) <= staleAfterMs
		)
			return source;
		const id = `SOURCE_UNAVAILABLE:${source.kind}`;
		if (!alerts.some((alert) => alert.id === id && alert.state === "firing")) {
			const earlier = alerts.findIndex((alert) => alert.id === id);
			if (earlier >= 0) alerts.splice(earlier, 1);
			alerts.push({
				id,
				objectUid: null,
				objectName: source.kind,
				code: "SOURCE_UNAVAILABLE",
				severity: "warning",
				state: "firing",
				firstAt: new Date(
					Date.parse(source.observedAt) + staleAfterMs,
				).toISOString(),
				lastAt: now,
				resolvedAt: null,
				value: null,
				threshold: staleAfterMs / 1000,
			});
		}
		return { ...source, state: "stale" as const, reason: "STALE" as const };
	});
	return {
		...snapshot,
		generatedAt: now,
		sources,
		alerts: alerts.slice(0, 1000),
	};
}

export function evaluateOperationsAlertsV2(
	snapshot: OperationsResourcesV2,
	previous: readonly Alert[],
	thresholds = defaultOperationsAlertThresholdsV2,
): Alert[] {
	if (
		!Number.isFinite(thresholds.capacityRatio) ||
		thresholds.capacityRatio <= 0 ||
		thresholds.capacityRatio > 1 ||
		!Number.isFinite(thresholds.criticalRatio) ||
		thresholds.criticalRatio < thresholds.capacityRatio ||
		thresholds.criticalRatio > 1 ||
		!Number.isSafeInteger(thresholds.queueCount) ||
		thresholds.queueCount < 1
	)
		throw new Error("Invalid operations thresholds");
	const active = new Map<string, Alert>();
	const healthy = (kind: OperationsResourcesV2["sources"][number]["kind"]) =>
		snapshot.sources.some(
			(source) =>
				source.kind === kind &&
				source.state === "available" &&
				source.observedAt !== null &&
				Date.parse(snapshot.generatedAt) - Date.parse(source.observedAt) <=
					Math.max(90_000, snapshot.refreshSeconds * 3000),
		);
	const add = (
		code: Alert["code"],
		objectUid: string | null,
		objectName: string,
		value: number | null = null,
		threshold: number | null = null,
		critical = false,
	) => {
		const id = `${code}:${objectUid ?? objectName}`;
		const old = previous.find(
			(alert) => alert.id === id && alert.state === "firing",
		);
		active.set(id, {
			id,
			code,
			objectUid,
			objectName,
			value,
			threshold,
			severity: critical ? "critical" : "warning",
			state: "firing",
			firstAt: old?.firstAt ?? snapshot.generatedAt,
			lastAt: snapshot.generatedAt,
			resolvedAt: null,
		});
	};
	const capacity = (
		code: Alert["code"],
		uid: string,
		name: string,
		used: number | null,
		limit: number | null,
	) => {
		if (
			used !== null &&
			limit !== null &&
			limit > 0 &&
			used / limit >= thresholds.capacityRatio
		)
			add(
				code,
				uid,
				name,
				used / limit,
				thresholds.capacityRatio,
				used / limit >= thresholds.criticalRatio,
			);
	};
	for (const node of snapshot.nodes)
		if (
			!node.virtual &&
			node.pressures.length > 0 &&
			Date.parse(snapshot.generatedAt) -
				Date.parse(node.identityObservedAt ?? node.observedAt) <=
				Math.max(90_000, snapshot.refreshSeconds * 3000)
		)
			add("NODE_PRESSURE", node.uid, node.name, null, null, true);
	if (healthy("node-metrics"))
		for (const node of snapshot.nodes) {
			if (node.virtual) continue;
			capacity(
				"MEMORY_PRESSURE",
				node.uid,
				node.name,
				node.usage.memoryBytes,
				node.allocatable.memoryBytes,
			);
			capacity(
				"CPU_PRESSURE",
				node.uid,
				node.name,
				node.usage.cpuCores,
				node.allocatable.cpuCores,
			);
		}
	if (healthy("pod-metrics"))
		for (const resource of snapshot.resources) {
			if (resource.kind !== "Pod") continue;
			capacity(
				"MEMORY_PRESSURE",
				resource.uid,
				resource.name,
				resource.usage.memoryBytes,
				resource.limits.memoryBytes,
			);
			capacity(
				"CPU_PRESSURE",
				resource.uid,
				resource.name,
				resource.usage.cpuCores,
				resource.limits.cpuCores,
			);
		}
	if (healthy("kubernetes")) {
		for (const quota of snapshot.quotas)
			for (const value of quota.values)
				capacity(
					"QUOTA_PRESSURE",
					`${quota.uid}:${value.resource}`,
					quota.name,
					value.used,
					value.hard,
				);
		for (const resource of snapshot.resources)
			if (
				resource.kind === "Pod" &&
				resource.reason &&
				[
					"OOMKilled",
					"CrashLoopBackOff",
					"ImagePullBackOff",
					"ErrImagePull",
					"Unschedulable",
				].includes(resource.reason)
			)
				add(
					"POD_UNAVAILABLE",
					resource.uid,
					resource.name,
					null,
					null,
					resource.reason === "OOMKilled",
				);
	}
	if (healthy("platform")) {
		if (snapshot.database) {
			capacity(
				"DATABASE_PRESSURE",
				"postgres-role",
				"API 数据库账号",
				snapshot.database.connections,
				snapshot.database.roleConnectionLimit,
			);
			capacity(
				"DATABASE_PRESSURE",
				"postgres-database",
				"当前数据库连接",
				snapshot.database.databaseConnections,
				snapshot.database.maxConnections,
			);
		}
		const budget = snapshot.budget;
		if (budget?.enabled && budget.limits)
			for (const key of ["cpuCores", "memoryBytes", "storageBytes"] as const)
				capacity(
					"RESERVE_PRESSURE",
					`${budget.namespace}:${key}`,
					budget.namespace,
					budget.reserveUsage[key],
					budget.limits[key],
				);
		if (
			snapshot.queue &&
			Math.max(snapshot.queue.waiting, snapshot.queue.outboxPending) >=
				thresholds.queueCount
		)
			add(
				"QUEUE_BACKLOG",
				null,
				snapshot.scope.namespace,
				Math.max(snapshot.queue.waiting, snapshot.queue.outboxPending),
				thresholds.queueCount,
			);
	}
	if (healthy("image-cache")) {
		const owners = new Map<string, OperationsResourcesV2["imageCaches"]>();
		for (const cache of snapshot.imageCaches) {
			owners.set(cache.owner, [...(owners.get(cache.owner) ?? []), cache]);
			if (
				cache.expiresAt &&
				Date.parse(cache.expiresAt) <= Date.parse(snapshot.generatedAt)
			)
				add("CACHE_EXPIRED", cache.uid, cache.name);
		}
		for (const [owner, caches] of owners)
			capacity(
				"CACHE_INVENTORY",
				owner,
				owner,
				caches.length,
				caches[0]?.inventoryLimit ?? null,
			);
	}
	for (const source of snapshot.sources)
		if (["unavailable", "stale"].includes(source.state))
			add("SOURCE_UNAVAILABLE", null, source.kind);
	const canResolve = (alert: Alert) => {
		if (snapshot.truncated) return false;
		switch (alert.code) {
			case "NODE_PRESSURE": {
				const node = snapshot.nodes.find(
					(entry) => entry.uid === alert.objectUid,
				);
				return node
					? node.pressures.length === 0 &&
							Date.parse(snapshot.generatedAt) -
								Date.parse(node.identityObservedAt ?? node.observedAt) <=
								Math.max(90_000, snapshot.refreshSeconds * 3000)
					: healthy("node-metrics");
			}
			case "MEMORY_PRESSURE":
			case "CPU_PRESSURE":
				if (snapshot.nodes.some((node) => node.uid === alert.objectUid))
					return healthy("node-metrics");
				if (
					snapshot.resources.some(
						(resource) => resource.uid === alert.objectUid,
					)
				)
					return healthy("pod-metrics");
				return (
					healthy("kubernetes") &&
					healthy("node-metrics") &&
					healthy("pod-metrics")
				);
			case "QUOTA_PRESSURE":
			case "POD_UNAVAILABLE":
				return healthy("kubernetes");
			case "RESERVE_PRESSURE":
			case "QUEUE_BACKLOG":
			case "DATABASE_PRESSURE":
				return healthy("platform");
			case "CACHE_INVENTORY":
			case "CACHE_EXPIRED":
				return healthy("image-cache");
			case "SOURCE_UNAVAILABLE":
				return snapshot.sources.some(
					(source) =>
						source.kind === alert.objectName && source.state === "available",
				);
		}
	};
	for (const old of previous) {
		if (active.has(old.id)) continue;
		if (old.state === "firing" && canResolve(old))
			active.set(old.id, {
				...old,
				state: "resolved",
				resolvedAt: snapshot.generatedAt,
			});
		else if (
			old.state === "firing" ||
			(old.resolvedAt &&
				Date.parse(snapshot.generatedAt) - Date.parse(old.resolvedAt) <
					7 * 86400_000)
		)
			active.set(old.id, old);
	}
	return [...active.values()]
		.sort(
			(a, b) =>
				Number(b.state === "firing") - Number(a.state === "firing") ||
				b.lastAt.localeCompare(a.lastAt),
		)
		.slice(0, 1000);
}
