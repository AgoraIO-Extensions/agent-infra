import type { Writable } from "node:stream";
import { ExportResultCode } from "@opentelemetry/core";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import {
	defaultResource,
	resourceFromAttributes,
} from "@opentelemetry/resources";
import {
	AggregationTemporality,
	InstrumentType,
	MeterProvider,
	PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
	BasicTracerProvider,
	BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
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
	"browser",
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

export interface ModelTokenUsage {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cachedInputTokens?: number;
}

const tokenKinds = {
	inputTokens: "input",
	outputTokens: "output",
	cachedInputTokens: "cached_input",
} as const;

export const resourceKinds = [
	"sse_connections",
	"sse_pending_events",
	"task_waiting",
	"outbox_pending",
	"postgres_pool_active",
	"postgres_pool_idle",
	"postgres_pool_waiting",
] as const;

export interface ResourceSnapshot {
	readonly kind: (typeof resourceKinds)[number];
	readonly value: number;
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
const knownResourceKinds = new Set<string>(resourceKinds);
const identifier =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const operationIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function safeId(value: unknown) {
	return typeof value === "string" && identifier.test(value)
		? value
		: undefined;
}

function safeOperationRef(value: string | undefined) {
	return typeof value === "string" && operationIdentifier.test(value)
		? value
		: undefined;
}

function signalUrl(endpoint: string, signal: "traces" | "metrics") {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		throw new TypeError("Invalid observability endpoint");
	}
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
	const {
		service,
		otlpEndpoint,
		metricIntervalMs,
		output: configuredOutput,
	} = options;
	if (!services.includes(service))
		throw new TypeError("Invalid observability service");
	if (
		metricIntervalMs !== undefined &&
		(!Number.isSafeInteger(metricIntervalMs) ||
			metricIntervalMs < 1000 ||
			metricIntervalMs > 60_000)
	)
		throw new TypeError("Invalid observability metric interval");
	const traceUrl =
		otlpEndpoint !== undefined ? signalUrl(otlpEndpoint, "traces") : undefined;
	const metricUrl =
		otlpEndpoint !== undefined ? signalUrl(otlpEndpoint, "metrics") : undefined;
	const metricInterval = metricIntervalMs ?? 5000;
	const output = configuredOutput ?? process.stdout;
	let backpressured = false;
	let closingOutput = false;
	let abandonExports = false;
	let state: "active" | "closing" | "closed" = "active";
	let pendingWrites = 0;
	let errorEvents = 0;
	let awaitingWriteError = false;
	let droppedLogs = 0;
	let invalidRecords = 0;
	let captureFailures = 0;
	let exportFailures = 0;
	let lastExportFailureAt: string | undefined;
	const resourceValues = new Map<
		ResourceSnapshot["kind"],
		{ value: number; sampledAt: number }
	>();
	const onDrain = () => {
		backpressured = false;
	};
	output.on("drain", onDrain);
	const releaseErrorListener = () => {
		if (closingOutput && pendingWrites === 0 && !awaitingWriteError)
			setImmediate(() => {
				if (closingOutput && pendingWrites === 0 && !awaitingWriteError)
					output.off("error", onError);
			});
	};
	const onError = () => {
		errorEvents++;
		awaitingWriteError = false;
		backpressured = true;
		droppedLogs++;
		if (closingOutput && pendingWrites === 0) output.off("error", onError);
	};
	output.on("error", onError);
	const logger = pino(
		{
			base: { service },
			timestamp: pino.stdTimeFunctions.isoTime,
		},
		{
			write(line: string) {
				if (backpressured || closingOutput) {
					droppedLogs++;
					return;
				}
				pendingWrites++;
				const previousErrorEvents = errorEvents;
				try {
					if (
						!output.write(line, (error) => {
							pendingWrites--;
							if (error && errorEvents === previousErrorEvents)
								awaitingWriteError = true;
							releaseErrorListener();
						})
					)
						backpressured = true;
				} catch {
					pendingWrites--;
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
	let providers:
		| { tracer: BasicTracerProvider; meter: MeterProvider }
		| undefined;
	if (traceUrl && metricUrl) {
		class TraceExporter extends OTLPTraceExporter {
			override export(
				...[spans, callback]: Parameters<OTLPTraceExporter["export"]>
			) {
				if (abandonExports) {
					noteExport(ExportResultCode.FAILED);
					callback({ code: ExportResultCode.FAILED });
					return;
				}
				try {
					return super.export(spans, (result) => {
						noteExport(result.code);
						callback(result);
					});
				} catch {
					noteExport(ExportResultCode.FAILED);
					callback({ code: ExportResultCode.FAILED });
				}
			}
		}
		class MetricExporter extends OTLPMetricExporter {
			override selectAggregationTemporality(instrumentType: InstrumentType) {
				// Cumulative storage retains expired observable points indefinitely.
				return instrumentType === InstrumentType.OBSERVABLE_GAUGE
					? AggregationTemporality.DELTA
					: super.selectAggregationTemporality(instrumentType);
			}
			override export(
				...[data, callback]: Parameters<OTLPMetricExporter["export"]>
			) {
				if (abandonExports) {
					noteExport(ExportResultCode.FAILED);
					callback({ code: ExportResultCode.FAILED });
					return;
				}
				try {
					return super.export(data, (result) => {
						noteExport(result.code);
						callback(result);
					});
				} catch {
					noteExport(ExportResultCode.FAILED);
					callback({ code: ExportResultCode.FAILED });
				}
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
		const resource = defaultResource().merge(
			resourceFromAttributes({ "service.name": service }),
		);
		providers = {
			tracer: new BasicTracerProvider({
				resource,
				spanProcessors: [
					new BatchSpanProcessor(traceExporter, {
						maxQueueSize: 512,
						maxExportBatchSize: 32,
						scheduledDelayMillis: 1000,
						exportTimeoutMillis: 2000,
					}),
				],
			}),
			meter: new MeterProvider({
				resource,
				readers: [
					new PeriodicExportingMetricReader({
						exporter: metricExporter,
						exportIntervalMillis: metricInterval,
						exportTimeoutMillis: Math.min(metricInterval, 2000),
					}),
				],
			}),
		};
	}
	const meter = providers?.meter.getMeter("agent-infra-observability");
	const tracer = providers?.tracer.getTracer("agent-infra-observability");
	const operations = meter?.createCounter("agent_platform_operations_total", {
		description: "Observed platform stage outcomes",
	});
	const duration = meter?.createHistogram("agent_platform_operation_duration", {
		unit: "ms",
		description: "Observed platform stage duration",
	});
	const tokens = meter?.createCounter("agent_platform_model_tokens_total", {
		unit: "{token}",
		description: "First committed observations of known model token fields",
	});
	meter
		?.createObservableGauge("agent_platform_resource_count", {
			unit: "1",
			description: "Latest observed platform resource count",
		})
		.addCallback((result) => {
			if (state !== "active") return;
			try {
				const now = performance.now();
				for (const [kind, snapshot] of resourceValues) {
					if (now - snapshot.sampledAt >= metricInterval * 3) {
						resourceValues.delete(kind);
						continue;
					}
					try {
						result.observe(snapshot.value, { service, kind });
					} catch {
						captureFailures++;
					}
				}
			} catch {
				captureFailures++;
			}
		});
	let closing: Promise<void> | undefined;
	return {
		recordModelUsage(usage: ModelTokenUsage) {
			if (state !== "active") return;
			try {
				const fields = Object.keys(tokenKinds) as (keyof ModelTokenUsage)[];
				const samples = fields.map((field) => [field, usage[field]] as const);
				if (
					samples.some(
						([, value]) =>
							value !== undefined &&
							(!Number.isSafeInteger(value) || value < 0),
					)
				) {
					invalidRecords++;
					return;
				}
				for (const [field, value] of samples) {
					if (value !== undefined)
						tokens?.add(value, { service, kind: tokenKinds[field] });
				}
			} catch {
				captureFailures++;
			}
		},
		observeResource(snapshot: ResourceSnapshot) {
			if (state !== "active") return;
			try {
				const { kind, value } = snapshot;
				if (
					!knownResourceKinds.has(kind) ||
					!Number.isSafeInteger(value) ||
					value < 0
				) {
					invalidRecords++;
					return;
				}
				resourceValues.set(kind, { value, sampledAt: performance.now() });
			} catch {
				captureFailures++;
			}
		},
		record(event: OperationalEvent) {
			if (state !== "active") {
				droppedLogs++;
				return;
			}
			try {
				const {
					stage,
					outcome,
					durationMs,
					code,
					requestId,
					traceId,
					agentId,
					conversationId,
					executionId,
					operationRef,
					attemptRef,
				} = event;
				if (!stages.has(stage) || !outcomes.has(outcome)) {
					invalidRecords++;
					return;
				}
				if (
					durationMs !== undefined &&
					(!Number.isFinite(durationMs) ||
						durationMs < 0 ||
						durationMs > 86_400_000)
				) {
					invalidRecords++;
					return;
				}
				const labels = {
					service,
					stage,
					outcome,
				};
				const details = {
					...labels,
					...(code && codes.has(code) ? { code } : {}),
					...(safeId(requestId) ? { requestId } : {}),
					...(safeId(traceId) ? { traceId } : {}),
					...(safeId(agentId) ? { agentId } : {}),
					...(safeId(conversationId) ? { conversationId } : {}),
					...(safeId(executionId) ? { executionId } : {}),
					...(safeOperationRef(operationRef) ? { operationRef } : {}),
					...(safeOperationRef(attemptRef) ? { attemptRef } : {}),
				};
				operations?.add(1, labels);
				if (durationMs !== undefined) duration?.record(durationMs, labels);
				tracer?.startSpan(`platform.${stage}`, { attributes: details }).end();
				// Stage duration is bounded metadata; logging it lets latency be
				// compared across deployments without an exporter (#1525).
				const logged =
					durationMs === undefined
						? details
						: { ...details, durationMs: Math.round(durationMs) };
				if (outcome === "failed" || outcome === "unknown")
					logger.error(logged, "operation");
				else logger.info(logged, "operation");
			} catch {
				captureFailures++;
			}
		},
		status: () => ({
			enabled: providers !== undefined,
			state,
			captureFailures,
			exportFailures,
			lastExportFailureAt,
			droppedLogs,
			invalidRecords,
		}),
		close() {
			closing ??= (async () => {
				state = "closing";
				resourceValues.clear();
				closingOutput = true;
				output.off("drain", onDrain);
				if (pendingWrites === 0 && !awaitingWriteError)
					output.off("error", onError);
				let timer: ReturnType<typeof setTimeout> | undefined;
				let timedOut = false;
				try {
					const shutdown = Promise.resolve()
						.then(() =>
							Promise.allSettled([
								Promise.resolve().then(() => providers?.tracer.shutdown()),
								Promise.resolve().then(() => providers?.meter.shutdown()),
							]),
						)
						.then((results) => {
							if (
								!timedOut &&
								results.some((result) => result.status === "rejected")
							)
								noteExport(ExportResultCode.FAILED);
						})
						.finally(() => {
							state = "closed";
						});
					await Promise.race([
						shutdown,
						new Promise<void>((resolve) => {
							timer = setTimeout(() => {
								timedOut = true;
								abandonExports = true;
								noteExport(ExportResultCode.FAILED);
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
