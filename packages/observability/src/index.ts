import type { Writable } from "node:stream";
import { metrics, trace } from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import pino from "pino";

export const operationalStages = [
	"http",
	"authorization",
	"task_admission",
	"task_wait",
	"task_dispatch",
	"worker",
	"runtime",
	"model",
	"tool",
	"result_persist",
	"sse",
	"audit_write",
	"audit_query",
	"dependency",
] as const;

export type OperationalStage = (typeof operationalStages)[number];
export type OperationalOutcome =
	| "completed"
	| "rejected"
	| "failed"
	| "unknown";

export const operationalCodes = [
	"AUTHORIZATION_DENIED",
	"TASK_UNAVAILABLE",
	"RUNTIME_UNAVAILABLE",
	"DEPENDENCY_UNAVAILABLE",
	"PERSISTENCE_UNAVAILABLE",
	"AUDIT_UNAVAILABLE",
	"OPERATION_UNKNOWN",
] as const;

export type OperationalCode = (typeof operationalCodes)[number];

export interface OperationalEvent {
	readonly stage: OperationalStage;
	readonly outcome: OperationalOutcome;
	readonly durationMs?: number;
	readonly code?: OperationalCode;
	readonly requestId?: string;
	readonly traceId?: string;
	readonly agentId?: string;
	readonly conversationId?: string;
	readonly executionId?: string;
	readonly operationRef?: string;
	readonly attemptRef?: string;
}

const services = [
	"platform-api",
	"platform-worker",
	"enterprise-directory-sync",
] as const;

export interface ObservabilityOptions {
	readonly service: (typeof services)[number];
	readonly otlpEndpoint?: string;
	readonly output?: Pick<Writable, "write" | "on" | "off">;
	readonly metricIntervalMs?: number;
}

const outcomes = new Set<OperationalOutcome>([
	"completed",
	"rejected",
	"failed",
	"unknown",
]);
const stages = new Set<string>(operationalStages);
const codes = new Set<string>(operationalCodes);
const identifier =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeId(value: string | undefined) {
	return value && identifier.test(value) ? value : undefined;
}

function signalUrl(endpoint: string, signal: "traces" | "metrics") {
	const url = new URL(endpoint);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		!url.hostname ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw new TypeError("Invalid observability endpoint");
	const base = url.href.endsWith("/") ? url.href : `${url.href}/`;
	return new URL(`v1/${signal}`, base).href;
}

export function startObservability(options: ObservabilityOptions) {
	if (!services.includes(options.service))
		throw new TypeError("Invalid observability service");
	if (
		options.metricIntervalMs !== undefined &&
		(!Number.isSafeInteger(options.metricIntervalMs) ||
			options.metricIntervalMs < 1000 ||
			options.metricIntervalMs > 60_000)
	)
		throw new TypeError("Invalid observability metric interval");
	const traceUrl = options.otlpEndpoint
		? signalUrl(options.otlpEndpoint, "traces")
		: undefined;
	const metricUrl = options.otlpEndpoint
		? signalUrl(options.otlpEndpoint, "metrics")
		: undefined;
	const output = options.output ?? process.stdout;
	let backpressured = false;
	let droppedLogs = 0;
	let invalidRecords = 0;
	let exportFailures = 0;
	let lastExportFailureAt: string | undefined;
	const onDrain = () => {
		backpressured = false;
	};
	output.on("drain", onDrain);
	const onError = () => {
		backpressured = true;
		droppedLogs++;
	};
	output.on("error", onError);
	const logger = pino(
		{
			base: { service: options.service },
			timestamp: pino.stdTimeFunctions.isoTime,
		},
		{
			write(line: string) {
				if (backpressured) {
					droppedLogs++;
					return;
				}
				try {
					if (!output.write(line)) backpressured = true;
				} catch {
					backpressured = true;
					droppedLogs++;
				}
			},
		},
	);
	const noteExport = (code: number) => {
		if (code === ExportResultCode.SUCCESS) return;
		exportFailures++;
		lastExportFailureAt = new Date().toISOString();
	};
	let sdk: NodeSDK | undefined;
	if (traceUrl && metricUrl) {
		class TraceExporter extends OTLPTraceExporter {
			override export(
				...[spans, callback]: Parameters<OTLPTraceExporter["export"]>
			) {
				return super.export(spans, (result) => {
					noteExport(result.code);
					callback(result);
				});
			}
		}
		class MetricExporter extends OTLPMetricExporter {
			override export(
				...[data, callback]: Parameters<OTLPMetricExporter["export"]>
			) {
				return super.export(data, (result) => {
					noteExport(result.code);
					callback(result);
				});
			}
		}
		const traceExporter = new TraceExporter({
			url: traceUrl,
			timeoutMillis: 2000,
			concurrencyLimit: 1,
		});
		const metricExporter = new MetricExporter({
			url: metricUrl,
			timeoutMillis: 2000,
			concurrencyLimit: 1,
		});
		sdk = new NodeSDK({
			serviceName: options.service,
			autoDetectResources: false,
			spanProcessors: [
				new BatchSpanProcessor(traceExporter, {
					maxQueueSize: 512,
					maxExportBatchSize: 32,
					scheduledDelayMillis: 1000,
					exportTimeoutMillis: 2000,
				}),
			],
			metricReaders: [
				new PeriodicExportingMetricReader({
					exporter: metricExporter,
					exportIntervalMillis: options.metricIntervalMs ?? 5000,
					exportTimeoutMillis: Math.min(options.metricIntervalMs ?? 5000, 2000),
				}),
			],
		});
		sdk.start();
	}
	const meter = metrics.getMeter("agent-infra-observability");
	const tracer = trace.getTracer("agent-infra-observability");
	const operations = meter.createCounter("agent_platform_operations_total", {
		description: "Observed platform stage outcomes",
	});
	const duration = meter.createHistogram("agent_platform_operation_duration", {
		unit: "ms",
		description: "Observed platform stage duration",
	});
	let closing: Promise<void> | undefined;
	return {
		record(event: OperationalEvent) {
			if (!stages.has(event.stage) || !outcomes.has(event.outcome)) {
				invalidRecords++;
				return;
			}
			if (
				event.durationMs !== undefined &&
				(!Number.isFinite(event.durationMs) ||
					event.durationMs < 0 ||
					event.durationMs > 86_400_000)
			) {
				invalidRecords++;
				return;
			}
			const labels = {
				service: options.service,
				stage: event.stage,
				outcome: event.outcome,
			};
			const details = {
				...labels,
				...(event.code && codes.has(event.code) ? { code: event.code } : {}),
				...(safeId(event.requestId) ? { requestId: event.requestId } : {}),
				...(safeId(event.traceId) ? { traceId: event.traceId } : {}),
				...(safeId(event.agentId) ? { agentId: event.agentId } : {}),
				...(safeId(event.conversationId)
					? { conversationId: event.conversationId }
					: {}),
				...(safeId(event.executionId)
					? { executionId: event.executionId }
					: {}),
				...(safeId(event.operationRef)
					? { operationRef: event.operationRef }
					: {}),
				...(safeId(event.attemptRef) ? { attemptRef: event.attemptRef } : {}),
			};
			try {
				operations.add(1, labels);
				if (event.durationMs !== undefined)
					duration.record(event.durationMs, labels);
				const span = tracer.startSpan(`platform.${event.stage}`, {
					attributes: details,
				});
				span.end();
				if (event.outcome === "failed" || event.outcome === "unknown")
					logger.error(details, "operation");
				else logger.info(details, "operation");
			} catch {
				// Telemetry does not decide the business outcome.
			}
		},
		status: () => ({
			enabled: sdk !== undefined,
			exportFailures,
			lastExportFailureAt,
			droppedLogs,
			invalidRecords,
		}),
		close() {
			closing ??= (async () => {
				output.off("drain", onDrain);
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						Promise.resolve()
							.then(() => sdk?.shutdown())
							.catch(() => noteExport(1)),
						new Promise<void>((resolve) => {
							timer = setTimeout(() => {
								noteExport(1);
								resolve();
							}, 5000);
						}),
					]);
				} finally {
					clearTimeout(timer);
				}
			})();
			return closing;
		},
	};
}
