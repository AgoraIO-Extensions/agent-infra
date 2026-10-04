import { createHash } from "node:crypto";
import { createServer } from "node:http";

const kinds = {
	PlatformPersistentBacklog: "backlog",
	PlatformHttpErrors: "errors",
	PlatformCollectorUnavailable: "service",
} as const;
const receipts: {
	alertname: string;
	status: "firing" | "resolved";
	kind: string;
	payloadSha256: string;
}[] = [];

createServer(
	{ requestTimeout: 5000, headersTimeout: 5000 },
	async (request, response) => {
		try {
			if (request.method === "GET" && request.url === "/receipts") {
				response.setHeader("Content-Type", "application/json");
				response.end(JSON.stringify(receipts));
				return;
			}
			if (request.method !== "POST" || request.url !== "/alerts")
				throw new Error();
			let text = "";
			for await (const chunk of request) {
				text += String(chunk);
				if (Buffer.byteLength(text) > 65_536) throw new Error();
			}
			if (/PRIVATE_(BODY|CURSOR)_SENTINEL/.test(text)) throw new Error();
			const body = JSON.parse(text);
			if (!Array.isArray(body.alerts) || body.alerts.length > 3)
				throw new Error();
			const incoming = body.alerts.map(
				(alert: {
					status: "firing" | "resolved";
					labels: Record<string, string>;
				}) => {
					const name = alert.labels.alertname as keyof typeof kinds;
					if (
						!Object.hasOwn(kinds, name) ||
						!["firing", "resolved"].includes(alert.status) ||
						alert.labels.kind !== kinds[name] ||
						alert.labels.severity !== "warning" ||
						Object.keys(alert.labels).some(
							(key) => !["alertname", "kind", "severity"].includes(key),
						)
					)
						throw new Error();
					return {
						alertname: name,
						status: alert.status,
						kind: kinds[name],
						payloadSha256: createHash("sha256").update(text).digest("hex"),
					};
				},
			);
			if (receipts.length + incoming.length > 128) throw new Error();
			receipts.push(...incoming);
			response.end();
		} catch {
			response.statusCode = 400;
			response.end();
		}
	},
).listen(9411, "0.0.0.0");
