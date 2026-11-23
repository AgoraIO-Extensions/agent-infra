// All ARMS targets share the dashboard time picker. Labels are deployment inputs.
export function ackHistoryPanels(
	uid: string,
	clusterLabel: string,
	cluster: string,
	namespace: string,
) {
	if (
		!/^[A-Za-z0-9_-]{1,40}$/.test(uid) ||
		!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(clusterLabel) ||
		[
			"namespace",
			"pod",
			"node",
			"instance",
			"job",
			"uid",
			"condition",
			"phase",
			"container",
			"mode",
			"cpu",
			"persistentvolumeclaim",
		].includes(clusterLabel) ||
		!/^[a-zA-Z0-9._:-]{1,128}$/.test(cluster) ||
		!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(namespace)
	)
		throw new Error(
			"Invalid ACK datasource UID, cluster label, cluster or namespace",
		);
	const scope = `${clusterLabel}="${cluster}"`;
	const ns = `${scope},namespace="${namespace}"`;
	const pod = "namespace,pod,uid";
	const pvc = "namespace,persistentvolumeclaim";
	const containers = `${ns},container!="",container!="POD",pod!=""`;
	const mem = `container_memory_working_set_bytes{${containers}}`;
	const cpu = `container_cpu_usage_seconds_total{${containers}}`;
	const nodeMem = `node_memory_MemTotal_bytes{${scope},node!=""}`;
	const nodeAvailable = `node_memory_MemAvailable_bytes{${scope},node!=""}`;
	const nodeCpu = `node_cpu_seconds_total{${scope},node!="",mode!="idle"}`;
	const pods = `kube_pod_info{${ns}}`;
	const ready = `kube_pod_status_ready{${ns},condition="true"}`;
	const restarts = `kube_pod_container_status_restarts_total{${ns}}`;
	const phase = `kube_persistentvolumeclaim_status_phase{${ns}}`;
	const request = `kube_persistentvolumeclaim_resource_requests_storage_bytes{${ns}}`;
	const used = `kubelet_volume_stats_used_bytes{${ns}}`;
	// Prometheus instant selectors carry samples forward for the lookback period.
	// Drop gauges and counters whose latest raw scrape is more than two minutes old.
	const fresh = (s: string) => `(${s} and (timestamp(${s}) >= time() - 120))`;
	const rate = (s: string) => `(rate(${s}[5m]) and ${fresh(s)})`;
	const sum = (labels: string, expr: string) =>
		`sum(max by (${labels}) (${expr}))`;
	const count = (labels: string, expr: string) =>
		`count(group by (${labels}) (${expr}))`;
	const datasource = { type: "prometheus", uid };
	let id = 10;
	function panel(title: string, unit: string, queries: [string, string][]) {
		const index = id++;
		return {
			id: index,
			title,
			type: "timeseries",
			datasource,
			description: `ARMS · ${cluster} / ${namespace} · 所选时段。节点为共享集群总量。缺样保留断点，覆盖数见下方。`,
			gridPos: {
				x: ((index - 10) % 2) * 12,
				y: 36 + Math.floor((index - 10) / 2) * 8,
				w: 12,
				h: 8,
			},
			fieldConfig: {
				defaults: { unit, custom: { spanNulls: false } },
				overrides: [],
			},
			targets: queries.map(([legendFormat, expr], i) => ({
				refId: String.fromCharCode(65 + i),
				datasource,
				range: true,
				instant: false,
				interval: "30s",
				legendFormat,
				expr,
			})),
		};
	}
	const panels = [
		panel("CPU 实测 · 有样本范围", "cores", [
			["节点（共享）", sum("node,cpu,mode", rate(nodeCpu))],
			["namespace 容器", sum("namespace,pod,container,id", rate(cpu))],
		]),
		panel("内存实测 · 有样本范围", "bytes", [
			[
				"节点（共享）",
				`sum(max by (node) (${fresh(nodeMem)}) - max by (node) (${fresh(nodeAvailable)}))`,
			],
			["namespace 工作集", sum("namespace,pod,container,id", fresh(mem))],
		]),
		panel("Pod 状态", "short", [
			["已观测 Pod", count(pod, fresh(pods))],
			["Ready", sum(pod, fresh(ready))],
		]),
		panel("容器重启 · 当时存续容器累计值", "short", [
			["重启次数", sum(pod + ",container", fresh(restarts))],
		]),
		panel("PVC 状态", "short", [
			["{{phase}}", `sum by (phase) (max by (${pvc},phase) (${fresh(phase)}))`],
		]),
		panel("PVC 容量", "bytes", [
			["申请容量", sum(pvc, fresh(request))],
			["已采样卷实际用量", sum(pvc, fresh(used))],
		]),
		panel("采样覆盖 · 对象数", "short", [
			["CPU 节点", count("node", rate(nodeCpu))],
			[
				"内存节点",
				count(
					"node",
					`max by (node) (${fresh(nodeMem)}) and max by (node) (${fresh(nodeAvailable)})`,
				),
			],
			["CPU Pod", count("pod", rate(cpu))],
			["内存 Pod", count("pod", fresh(mem))],
			["Ready 指标 Pod", count(pod, fresh(ready))],
			["重启指标容器", count(pod + ",container", fresh(restarts))],
			["状态指标 PVC", count(pvc, fresh(phase))],
			["申请容量 PVC", count(pvc, fresh(request))],
			["有实际用量的 PVC", count(pvc, fresh(used))],
		]),
		panel(
			"原始采样时间 · 按指标来源",
			"dateTimeAsIso",
			Object.entries({
				"节点 CPU": nodeCpu,
				节点总内存: nodeMem,
				节点可用内存: nodeAvailable,
				"容器 CPU": cpu,
				容器内存: mem,
				"Pod 库存": pods,
				"Pod Ready": ready,
				容器重启: restarts,
				"PVC 状态": phase,
				"PVC 申请": request,
				"PVC 实测": used,
			}).map(([name, s]) => [name, `max(timestamp(${s})) * 1000`]),
		),
	];
	// Evaluate this bounded lookback once at the selected end time, including windows
	// entirely inside a gap. Aggregate before the subquery to bound its cardinality.
	const timestamps = panels[panels.length - 1];
	const lastSeen = {
		...timestamps,
		id: id++,
		title: "窗口结束前最近采样 · 回看一小时",
		type: "stat",
		gridPos: { x: 0, y: 68, w: 24, h: 6 },
		description:
			"按选定窗口结束时间回看最近一小时；超出回看范围或无可读样本显示无数据。",
		targets: timestamps.targets.map((t) => ({
			...t,
			instant: true,
			range: false,
			expr: `max_over_time((${t.expr})[1h:1m])`,
		})),
	};
	return [...panels, lastSeen];
}
