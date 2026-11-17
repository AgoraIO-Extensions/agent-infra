import type { OperationsHistoryQueryV2 } from "@agent-infra/contracts/pilot";

export interface OperationsHistoryIdentityV2 {
	uid: string;
	kind: string;
	name: string;
	firstSeen: string;
	lastSeen: string;
}
const quote = (value: string) => JSON.stringify(value);
const regex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function labelled(value: string, identity: OperationsHistoryIdentityV2) {
	return `label_replace((${value}),"uid",${quote(identity.uid.replaceAll("$", "$$"))},"__name__",".*")`;
}
function observed(
	value: string,
	selector: string,
	identity: OperationsHistoryIdentityV2,
) {
	const first = Date.parse(identity.firstSeen) / 1000;
	const last = Date.parse(identity.lastSeen) / 1000;
	return `(${value} and ignoring(__name__) (timestamp(${selector}) >= ${first}) and on() (vector(time()) >= ${first}) and on() (vector(time()) <= ${last}))`;
}

/** Identity/time filters precede range functions; a current name mapping never relabels an old counter range. */
export function operationsResourceHistoryPromqlV2(input: {
	metric: "cpu" | "memory" | "storage";
	namespace: string;
	identities: readonly OperationsHistoryIdentityV2[];
	stepSeconds: number;
	statistic: OperationsHistoryQueryV2["statistic"];
}): string | undefined {
	const expressions: string[] = [];
	for (const identity of input.identities) {
		let value: string | undefined;
		if (identity.kind === "Pod" && input.metric !== "storage") {
			const metric =
				input.metric === "cpu"
					? "container_cpu_usage_seconds_total"
					: "container_memory_working_set_bytes";
			const scope = `namespace=${quote(input.namespace)},pod=${quote(identity.name)},container!="",container!="POD"`;
			const cgroup = `.*[/-]pod(${regex(identity.uid)}|${regex(identity.uid.replaceAll("-", "_"))})(\\.slice)?(/.*|$)`;
			const selectors = [
				`uid=${quote(identity.uid)}`,
				`pod_uid=${quote(identity.uid)}`,
				`id=~${quote(cgroup)}`,
			].map((qualification) => `${metric}{${scope},${qualification}}`);
			const series = selectors.map((selector) =>
				input.metric === "cpu"
					? labelled(`rate(${selector}[2m])`, identity)
					: labelled(observed(selector, selector, identity), identity),
			);
			value = `sum by (pod,uid) (${series.join(" or ")})`;
		} else if (
			identity.kind === "PersistentVolumeClaim" &&
			input.metric === "storage"
		) {
			const selector = `kubelet_volume_stats_used_bytes{namespace=${quote(input.namespace)},persistentvolumeclaim=${quote(identity.name)}}`;
			value = `sum by (persistentvolumeclaim,uid) (${labelled(observed(selector, selector, identity), identity)})`;
		} else if (identity.kind === "Node" && input.metric !== "storage") {
			const scope = `node=${quote(identity.name)}`;
			if (input.metric === "memory") {
				const total = `node_memory_MemTotal_bytes{${scope}}`;
				const available = `node_memory_MemAvailable_bytes{${scope}}`;
				value = `sum by (node,uid) (${labelled(`${observed(total, total, identity)} - ${observed(available, available, identity)}`, identity)})`;
			} else {
				const counter = `node_cpu_seconds_total{${scope},mode!="idle"}`;
				const sampled = observed(counter, counter, identity);
				const timestamps = observed(`timestamp(${counter})`, counter, identity);
				// Subquery lookback must not turn one real scrape into a fabricated multi-sample zero rate.
				const rate = `(rate((${sampled})[2m:30s]) and ignoring(__name__) (changes((${timestamps})[2m:30s]) > 0))`;
				value = `sum by (node,uid) (${labelled(rate, identity)})`;
			}
		}
		if (!value) continue;
		const first = Date.parse(identity.firstSeen) / 1000;
		const last = Date.parse(identity.lastSeen) / 1000;
		expressions.push(
			`((${value}) and on() (vector(time()) >= ${first}) and on() (vector(time()) <= ${last}))`,
		);
	}
	if (!expressions.length) return undefined;
	return `${input.statistic === "maximum" ? "max_over_time" : "avg_over_time"}((${expressions.join(" or ")})[${input.stepSeconds}s:30s])`;
}
