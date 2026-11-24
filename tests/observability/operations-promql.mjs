import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { operationsResourceHistoryPromqlV2 as build } from "../../apps/platform-api/src/operations-history-promql.ts";
import { ackHistoryPanels } from "../../deploy/observability/grafana/ack-history.mts";

const require = createRequire(import.meta.url);
const YAML = require("yaml");
const uid = "11111111-2222-3333-4444-555555555555";
const iso = (s) => new Date(s * 1000).toISOString();
const expr = (kind, metric, statistic = "maximum", name = "same-name") =>
	build({
		metric,
		namespace: "ns",
		identities: [{ uid, kind, name, firstSeen: iso(150), lastSeen: iso(450) }],
		stepSeconds: 300,
		statistic,
	});
const tests = [];
function add(name, input_series, expression, at, exp_samples) {
	tests.push({
		name,
		interval: "30s",
		input_series,
		promql_expr_test: [{ expr: expression, eval_time: `${at}s`, exp_samples }],
	});
}
const pvc =
	'kubelet_volume_stats_used_bytes{namespace="ns",persistentvolumeclaim="same-name"}';
const total = 'node_memory_MemTotal_bytes{node="same-name"}';
const available = 'node_memory_MemAvailable_bytes{node="same-name"}';
const counter = 'node_cpu_seconds_total{node="same-name",cpu="0",mode="user"}';
const pvcLabels = `{persistentvolumeclaim="same-name",uid="${uid}"}`;
const nodeLabels = `{node="same-name",uid="${uid}"}`;
const count = (e) => `count(${e})`;
add(
	"pvc maximum excludes predecessor high values",
	[{ series: pvc, values: "1000 1000 1000 1000 1000 10 20" }],
	expr("PersistentVolumeClaim", "storage"),
	180,
	[{ labels: pvcLabels, value: 20 }],
);
add(
	"pvc average excludes predecessor high values",
	[{ series: pvc, values: "1000 1000 1000 1000 1000 10 20" }],
	expr("PersistentVolumeClaim", "storage", "average"),
	180,
	[{ labels: pvcLabels, value: 15 }],
);
add(
	"pvc no new scrape is absent despite lookback",
	[{ series: pvc, values: "1000 1000 1000 1000 1000 _ _ _ _" }],
	expr("PersistentVolumeClaim", "storage"),
	240,
	[],
);
add(
	"pvc sample immediately before firstSeen is absent",
	[{ series: pvc, values: "1000 1000 1000 1000 1000 _" }],
	expr("PersistentVolumeClaim", "storage"),
	150,
	[],
);
add(
	"pvc firstSeen sample itself is accepted",
	[{ series: pvc, values: "1000 1000 1000 1000 1000 10" }],
	expr("PersistentVolumeClaim", "storage"),
	150,
	[{ labels: pvcLabels, value: 10 }],
);
add(
	"node memory excludes predecessor high values",
	[
		{ series: total, values: "10000 10000 10000 10000 10000 1000 1000" },
		{ series: available, values: "0 0 0 0 0 900 900" },
	],
	expr("Node", "memory"),
	180,
	[{ labels: nodeLabels, value: 100 }],
);
add(
	"node memory absent when one operand has no new sample",
	[
		{ series: total, values: "10000 10000 10000 10000 10000 1000 1000" },
		{ series: available, values: "0 0 0 0 0 _ _" },
	],
	expr("Node", "memory"),
	180,
	[],
);
add(
	"node CPU no new scrape is absent",
	[{ series: counter, values: "10000 20000 30000 40000 50000 _ _ _ _ _" }],
	expr("Node", "cpu"),
	270,
	[],
);
add(
	"node CPU one new scrape is absent",
	[{ series: counter, values: "10000 20000 30000 40000 50000 100 _ _ _ _" }],
	expr("Node", "cpu"),
	270,
	[],
);
add(
	"node CPU two new scrapes produce one valid nonzero rate",
	[{ series: counter, values: "10000 20000 30000 40000 50000 100 130" }],
	count(`(${expr("Node", "cpu")} > 0) and (${expr("Node", "cpu")} <= 1)`),
	180,
	[{ labels: "{}", value: 1 }],
);
add(
	"node CPU stable new window excludes predecessor counter",
	[
		{
			series: counter,
			values: "10000 20000 30000 40000 50000 100 130 160 190 220",
		},
	],
	expr("Node", "cpu"),
	270,
	[{ labels: nodeLabels, value: 1 }],
);
const oldUid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
for (const mode of ["uid", "pod_uid", "id"]) {
	const label = (v) =>
		mode === "id"
			? `id="/kubepods/burstable/pod${v}/container"`
			: `${mode}="${v}"`;
	const series = (v) =>
		`container_cpu_usage_seconds_total{namespace="ns",pod="same-name",container="runtime",${label(v)}}`;
	add(
		`Pod CPU ${mode} excludes predecessor UID`,
		[
			{ series: series(oldUid), values: "0+3000x9" },
			{ series: series(uid), values: "_ _ _ _ _ 100 130 160 190 220" },
		],
		expr("Pod", "cpu"),
		270,
		[{ labels: `{pod="same-name",uid="${uid}"}`, value: 1 }],
	);
}
add(
	"Pod CPU rejects cgroup containing only a UID substring",
	[
		{
			series: `container_cpu_usage_seconds_total{namespace="ns",pod="same-name",container="runtime",id="/pod${uid}999/container"}`,
			values: "0+3000x9",
		},
	],
	expr("Pod", "cpu"),
	270,
	[],
);
for (const encodedUid of [uid, uid.replaceAll("-", "_")]) {
	const id = `/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod${encodedUid}.slice/cri-containerd-123.scope`;
	add(
		`Pod CPU systemd cgroup ${encodedUid} matches`,
		[
			{
				series: `container_cpu_usage_seconds_total{namespace="ns",pod="same-name",container="runtime",id="${id}"}`,
				values: "_ _ _ _ _ 100 130 160 190 220",
			},
		],
		expr("Pod", "cpu"),
		270,
		[{ labels: `{pod="same-name",uid="${uid}"}`, value: 1 }],
	);
}
add(
	"node CPU two unchanged real scrapes return a valid zero",
	[{ series: counter, values: "10000 20000 30000 40000 50000 100 100" }],
	expr("Node", "cpu"),
	180,
	[{ labels: nodeLabels, value: 0 }],
);
// Evaluate the exact Grafana targets against a source interruption and two unrelated environments.
const ack = ackHistoryPanels("arms", "cluster_id", "a", "ns");
const targets = ack.flatMap((panel) => panel.targets);
for (const { expr, legendFormat } of targets)
	add(
		`parse ACK target ${legendFormat}`,
		[],
		expr,
		60,
		legendFormat.endsWith("库存无样本") ? [{ labels: "{}", value: 1 }] : [],
	);
const requestTarget = targets.find((t) => t.legendFormat === "申请容量").expr;
const sampled = [
	{
		series:
			'kube_persistentvolumeclaim_resource_requests_storage_bytes{cluster_id="a",namespace="ns",persistentvolumeclaim="data",instance="r1"}',
		values: "10 10 _ _ _ _ _ _ 20",
	},
	{
		series:
			'kube_persistentvolumeclaim_resource_requests_storage_bytes{cluster_id="a",namespace="ns",persistentvolumeclaim="data",instance="r2"}',
		values: "10 10 _ _ _ _ _ _ 20",
	},
	{
		series:
			'kube_persistentvolumeclaim_resource_requests_storage_bytes{cluster_id="b",namespace="ns",persistentvolumeclaim="data"}',
		values: "900+0x10",
	},
	{
		series:
			'kube_persistentvolumeclaim_resource_requests_storage_bytes{cluster_id="a",namespace="neighbor",persistentvolumeclaim="data"}',
		values: "800+0x10",
	},
	{
		series:
			'kube_pod_info{cluster_id="a",namespace="ns",pod="healthy",uid="uid1"}',
		values: "1+0x10",
	},
];
for (const [at, value] of [
	[30, 10],
	[210, null],
	[240, 20],
]) {
	add(
		"PVC isolated and deduplicated at " + at,
		sampled,
		requestTarget,
		at,
		value === null ? [] : [{ labels: "{}", value }],
	);
}
add(
	"unrelated source stays queryable during PVC gap",
	sampled,
	targets.find((t) => t.legendFormat === "已观测 Pod").expr,
	210,
	[{ labels: "{}", value: 1 }],
);
const containerCpu = targets.find(
	(t) => t.legendFormat === "namespace 容器",
).expr;
const cpuStreams = ["0", "1"].flatMap((cpu) =>
	["one", "two"].map((replica) => ({
		series: `container_cpu_usage_seconds_total{cluster_id="a",namespace="ns",pod="p",container="worker",cpu="${cpu}",instance="${replica}"}`,
		values: "0+30x12",
	})),
);
add(
	"sum distinct container CPUs once across replicas",
	cpuStreams,
	containerCpu,
	300,
	[{ labels: "{}", value: 2 }],
);
const readyTarget = targets.find(
	(t) => t.legendFormat === "Ready 指标 Pod",
).expr;
add(
	"partial readiness feed retains its own coverage",
	[
		{
			series:
				'kube_pod_status_ready{cluster_id="a",namespace="ns",pod="p1",uid="u1",condition="true"}',
			values: "1+0x10",
		},
		{
			series:
				'kube_pod_status_ready{cluster_id="a",namespace="ns",pod="p2",uid="u2",condition="true"}',
			values: "1 stale",
		},
	],
	readyTarget,
	210,
	[{ labels: "{}", value: 1 }],
);
const lastSeen = targets.find(
	(t) => t.instant && t.legendFormat === "PVC 申请",
).expr;
add(
	"last raw timestamp survives an entire selected window of missing PVC data",
	[
		{
			series:
				'kube_persistentvolumeclaim_resource_requests_storage_bytes{cluster_id="a",namespace="ns",persistentvolumeclaim="data"}',
			values: "10 10 10 stale",
		},
	],
	lastSeen,
	900,
	[{ labels: "{}", value: 60000 }],
);
add(
	"last raw timestamp older than the window is absent without stale marker",
	[
		{
			series:
				'kube_persistentvolumeclaim_resource_requests_storage_bytes{cluster_id="a",namespace="ns",persistentvolumeclaim="old"}',
			values: "10",
		},
	],
	lastSeen,
	3720,
	[],
);
const missingPanel = ack.find(
	(panel) => panel.title === "历史库存 Pod · 缺少可归属样本",
);
add(
	"bound missing series per metric and instant",
	Array.from({ length: 23 }, (_, i) => ({
		series: `kube_pod_info{cluster_id="a",namespace="ns",pod="p${i}",uid="u${i}"}`,
		values: "1 1",
	})),
	count(missingPanel.targets[0].expr),
	30,
	[{ labels: "{}", value: 20 }],
);
const resourceFeeds = {
	CPU: ["container_cpu_usage_seconds_total", 'container="worker"'],
	内存: ["container_memory_working_set_bytes", 'container="worker"'],
	Ready: ["kube_pod_status_ready", 'condition="true"'],
	重启: ["kube_pod_container_status_restarts_total", 'container="worker"'],
};
const missingPod = {
	labels: `{namespace="ns",pod="rebuilt",uid="${uid}"}`,
	value: 1,
};
for (const target of missingPanel.targets) {
	const metric = target.legendFormat.split(" · ")[0];
	const [feed, selector] = resourceFeeds[metric];
	const scope = 'cluster_id="a",namespace="ns"';
	const series = (name, labels, values = "1+0x12") => ({
		series: `${name}{${scope},${labels}}`,
		values,
	});
	const input = [
		series("kube_pod_info", `pod="rebuilt",uid="${uid}",pod_ip="redacted"`),
		series("kube_pod_info", `pod="healthy",uid="${oldUid}"`),
		series(feed, `pod="rebuilt",uid="${oldUid}",${selector}`),
		series(feed, `pod="healthy",uid="${oldUid}",${selector}`),
		series(feed, `pod="rebuilt",${selector}`),
		{
			series: `${feed}{cluster_id="a",namespace="other",pod="rebuilt",uid="${uid}",${selector}}`,
			values: "1+0x12",
		},
	];
	add(`unattributed ${metric} for rebuilt Pod`, input, target.expr, 270, [
		missingPod,
	]);
	add(
		`no ${metric} gap without inventory`,
		input.slice(2),
		target.expr,
		270,
		[],
	);
	const matching =
		metric === "CPU" || metric === "内存"
			? [
					`uid="${uid}"`,
					`pod_uid="${uid}"`,
					`id="/kubepods/pod${uid}/worker"`,
					`id="/kubepods.slice/kubepods-burstable-pod${uid.replaceAll("-", "_")}.slice/worker"`,
				]
			: [`uid="${uid}"`];
	for (const identity of matching) {
		const recovered = [
			...input,
			series(
				feed,
				`pod="rebuilt",${identity},${selector}`,
				"_ _ _ _ _ _ _ _ _ 0 0",
			),
		];
		add(
			`new ${metric} samples with ${identity} close gap`,
			recovered,
			target.expr,
			300,
			[],
		);
	}
	const interrupted = [
		...input,
		series(
			feed,
			`pod="rebuilt",uid="${uid}",${selector}`,
			"1 1 _ _ _ _ _ _ _ _ _",
		),
	];
	add(`expired ${metric} scrape opens gap`, interrupted, target.expr, 240, [
		missingPod,
	]);
}
const sharedGaps = ack.find(
	(panel) => panel.title === "历史库存节点和 PVC · 缺少指标样本",
);
const nodeScope = 'cluster_id="a"';
const claimScope = 'cluster_id="a",namespace="ns"';
for (const [label, objectKey, inventoryMetric, scope, measures] of [
	["节点 CPU", "node", "kube_node_info", nodeScope, ["node_cpu_seconds_total"]],
	[
		"节点内存",
		"node",
		"kube_node_info",
		nodeScope,
		["node_memory_MemTotal_bytes", "node_memory_MemAvailable_bytes"],
	],
	[
		"PVC 状态",
		"persistentvolumeclaim",
		"kube_persistentvolumeclaim_info",
		claimScope,
		["kube_persistentvolumeclaim_status_phase"],
	],
	[
		"PVC 申请",
		"persistentvolumeclaim",
		"kube_persistentvolumeclaim_info",
		claimScope,
		["kube_persistentvolumeclaim_resource_requests_storage_bytes"],
	],
	[
		"PVC 实测",
		"persistentvolumeclaim",
		"kube_persistentvolumeclaim_info",
		claimScope,
		["kubelet_volume_stats_used_bytes"],
	],
]) {
	const gapTarget = sharedGaps.targets.find((t) =>
		t.legendFormat.startsWith(label),
	).expr;
	const mark = targets.find(
		(t) =>
			t.legendFormat ===
			(objectKey === "node" ? "节点库存无样本" : "PVC 库存无样本"),
	).expr;
	const series = (metric, name, values, deployment = scope) => ({
		series: `${metric}{${deployment},${objectKey}="${name}",instance="replica"}`,
		values,
	});
	const inventories = ["gap", "healthy"].map((name) =>
		series(inventoryMetric, name, "1+0x12"),
	);
	const otherScope =
		objectKey === "node"
			? 'cluster_id="b"'
			: 'cluster_id="a",namespace="other"';
	const feeds = measures.flatMap((m) => [
		series(m, "healthy", "1+0x12"),
		series(m, "gap", "1+0x12", otherScope),
	]);
	const labels =
		objectKey === "node"
			? '{node="gap"}'
			: '{namespace="ns",persistentvolumeclaim="gap"}';
	const partial =
		measures.length === 2 ? [series(measures[0], "gap", "1+0x12")] : [];
	add(
		`${label} only the confirmed unsampled object is identified`,
		[...inventories, ...feeds, ...partial],
		gapTarget,
		270,
		[{ labels, value: 1 }],
	);
	add(
		`${label} recovered zero is sampled`,
		[
			...inventories,
			...feeds,
			...measures.map((m) => series(m, "gap", "_ _ _ _ _ _ _ _ _ 0 0")),
		],
		gapTarget,
		300,
		[],
	);
	const staleInventory = [series(inventoryMetric, "gap", "1"), ...feeds];
	add(
		`${label} expired inventory yields no missing names`,
		staleInventory,
		gapTarget,
		270,
		[],
	);
	add(
		`${label} expired inventory is explicitly unknown`,
		staleInventory,
		mark,
		270,
		[{ labels: "{}", value: 1 }],
	);
	add(`${label} inventory recovers`, inventories, mark, 270, []);
	add(
		`${label} at most 20 names per step`,
		Array.from({ length: 21 }, (_, i) =>
			series(inventoryMetric, `r${i}`, "1 1"),
		),
		count(gapTarget),
		30,
		[{ labels: "{}", value: 20 }],
	);
}
const directory = mkdtempSync(join(tmpdir(), "operations-promql-"));
try {
	const file = join(directory, "rules.yaml");
	writeFileSync(
		file,
		YAML.stringify({ evaluation_interval: "30s", fuzzy_compare: true, tests }),
	);
	execFileSync(process.argv[2] ?? "promtool", ["test", "rules", file], {
		stdio: "inherit",
	});
} finally {
	rmSync(directory, { recursive: true, force: true });
}
