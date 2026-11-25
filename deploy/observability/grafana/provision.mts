// Generate the immutable part of a dedicated Grafana org's file provisioning.
// Credentials and the PostgreSQL TLS root certificate are supplied at runtime.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ackHistoryPanels } from "./ack-history.mts";

const [destination, platformOps, ...history] = process.argv.slice(2);
if (!destination || !platformOps)
	throw new Error("Usage: provision.mts NEW_DIRECTORY HTTPS_PLATFORM_OPS_URL");
const url = new URL(platformOps);
if (
	url.protocol !== "https:" ||
	url.username ||
	url.password ||
	url.search ||
	url.hash ||
	url.pathname !== "/ops"
)
	throw new Error("Expected the platform HTTPS /ops URL");

const uid = "platform-execution-impact-db";
const template = await readFile(
	new URL("./execution-impact.json", import.meta.url),
	"utf8",
);
const dashboard = JSON.parse(
	template
		.replaceAll("${DS_PLATFORM}", uid)
		.replaceAll("${PLATFORM_OPS}", () => url.href),
);
delete dashboard.__inputs;
const observe = history.at(-1) === "--observe-queries";
if (observe) history.pop();
if (observe && !history.length)
	throw new Error("ACK scope required for query observation");
let probe:
	| { uid: string; cluster: string; namespace: string; expr: string }
	| undefined;
let metricsDatasource = "";
if (history.length) {
	if (history.length !== 4 && history.length !== 5)
		throw new Error(
			"Expected ACK datasource UID, cluster label, cluster value, namespace and optional ARMS HTTPS endpoint",
		);
	const [source, label, cluster, namespace, endpoint] = history;
	if (source === uid)
		throw new Error("Business and ARMS datasource UIDs must be distinct");
	if (endpoint) {
		const address = new URL(endpoint);
		if (
			address.protocol !== "https:" ||
			address.username ||
			address.password ||
			address.search ||
			address.hash ||
			endpoint.includes("$")
		)
			throw new Error(
				"Expected an ARMS HTTPS base URL without credentials or query",
			);
		metricsDatasource = `  - name: ACK resource history
    uid: ${JSON.stringify(source)}
    orgId: 1
    type: prometheus
    access: proxy
    editable: false
    url: ${JSON.stringify(address.href)}
    basicAuth: true
    basicAuthUser: $OPS_ARMS_USER
    secureJsonData:
      basicAuthPassword: $OPS_ARMS_PASSWORD
    jsonData:
      httpMethod: POST
      timeInterval: 30s
`;
	}
	dashboard.panels.push(...ackHistoryPanels(source, label, cluster, namespace));
	if (observe) {
		const pods = `kube_pod_info{${label}="${cluster}",namespace="${namespace}"}`;
		probe = {
			uid: source,
			cluster,
			namespace,
			expr: `max(timestamp(${pods}))`,
		};
		const pg = { type: "grafana-postgresql-datasource", uid };
		const prom = { type: "prometheus", uid: source };
		const panelId =
			Math.max(...dashboard.panels.map((panel: { id: number }) => panel.id)) +
			1;
		const rawSql = `SELECT CASE
  WHEN checked_at IS NULL THEN '等待首次观测'
  WHEN checked_at < now() - interval '3 minutes' THEN '观测已过期'
  WHEN result = 'failed' THEN '查询失败'
  WHEN result = 'empty' THEN '查询成功 · Pod 库存无样本'
  ELSE '查询成功' END AS "状态",
  checked_at AS "最近查询", last_sample AS "最后有效样本",
  failed_at AS "首次观测到查询失败", recovered_at AS "首次恢复查询"
FROM (VALUES (1)) seed(n)
LEFT JOIN platform_ops_dashboard.ack_query_status s
ON s.source_uid='${source}' AND s.cluster_id='${cluster}' AND s.namespace='${namespace}'`;
		dashboard.panels.push(
			{
				id: panelId,
				title: "ACK 查询状态 · 当前观测",
				type: "table",
				datasource: pg,
				description:
					"每分钟通过 Grafana 查询目标 namespace 的 Pod 库存。保留最近一次查询中断和恢复时间。",
				gridPos: { x: 0, y: 115, w: 24, h: 5 },
				targets: [
					{
						refId: "A",
						format: "table",
						rawQuery: true,
						datasource: pg,
						rawSql,
					},
				],
			},
			{
				id: panelId + 1,
				title: "所选时段 · Pod 库存采样",
				type: "stat",
				datasource: prom,
				gridPos: { x: 0, y: 120, w: 24, h: 4 },
				description:
					"查询成功时显示所选窗口是否包含 Pod 库存原始样本。查询失败时请查看独立的查询状态。",
				fieldConfig: {
					defaults: {
						mappings: [
							{
								type: "value",
								options: {
									"0": { text: "所选时段有样本" },
									"1": { text: "查询成功 · 所选时段无样本" },
								},
							},
						],
					},
					overrides: [],
				},
				targets: [
					{
						refId: "A",
						instant: true,
						range: false,
						datasource: prom,
						expr: `absent_over_time(${pods}[$__range]) or on() vector(0)`,
					},
				],
			},
		);
	}
}
await mkdir(destination);
try {
	for (const dir of [
		"dashboards",
		"provisioning/dashboards",
		"provisioning/datasources",
	])
		await mkdir(join(destination, dir), { recursive: true });
	if (probe)
		await writeFile(
			join(destination, "query-observer.json"),
			JSON.stringify(probe) + "\n",
		);
	await writeFile(
		join(destination, "dashboards/execution-impact.json"),
		JSON.stringify(dashboard, null, 2) + "\n",
	);
	await writeFile(
		join(destination, "provisioning/dashboards/platform.yaml"),
		`apiVersion: 1
providers:
  - name: platform-execution-impact
    orgId: 1
    type: file
    allowUiUpdates: false
    disableDeletion: true
    options:
      path: /etc/grafana/platform-dashboards
`,
	);
	await writeFile(
		join(destination, "provisioning/datasources/platform.yaml"),
		`apiVersion: 1
datasources:
  - name: Platform execution impact
    uid: ${uid}
    orgId: 1
    type: grafana-postgresql-datasource
    access: proxy
    editable: false
    url: $OPS_PG_HOSTPORT
    user: $OPS_PG_USER
    jsonData:
      database: $OPS_PG_DATABASE
      sslmode: verify-full
      tlsConfigurationMethod: file-path
      sslRootCertFile: /etc/grafana/platform-ca/ca.crt
      maxOpenConns: 2
      maxIdleConns: 1
    secureJsonData:
      password: $OPS_PG_PASSWORD
${metricsDatasource}`,
	);
} catch (error) {
	await rm(destination, { recursive: true, force: true });
	throw error;
}
