import postgres from "./observed-postgres.js";

export function createGrafanaQueryStatusWriter(options: {
	host?: string;
	port: number;
	database?: string;
	username?: string;
	password?: string;
	ca: string;
}) {
	const { ca, ...connection } = options;
	const db = postgres({
		...connection,
		ssl: { ca, rejectUnauthorized: true },
		max: 1,
		connect_timeout: 5,
		connection: {
			statement_timeout: 5000,
			application_name: "grafana_query_observer",
		},
	});
	return async (row: {
		uid: string;
		cluster: string;
		namespace: string;
		checkedAt: Date;
		result: string;
		sample: Date | null;
	}) => {
		await db`SELECT platform_ops_dashboard.record_ack_query(${row.uid},${row.cluster},${row.namespace},${row.checkedAt},${row.result},${row.sample})`;
	};
}
