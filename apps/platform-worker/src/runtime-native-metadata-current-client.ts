import { Buffer } from "node:buffer";
import { isIP } from "node:net";
import {
	type NativeMetadataCurrentRequestV1,
	NativeMetadataCurrentRequestV1Schema,
	type NativeMetadataCurrentResponseV1,
	NativeMetadataCurrentResponseV1Schema,
	RuntimeNativeMetadataProofMaximumLifetimeMsV1,
} from "@agent-infra/contracts/runtime";
import {
	createNativeMetadataJsonTransport,
	logNativeMetadataHop,
} from "@agent-infra/native-metadata-transport";
import type { V1Endpoints, V1Pod } from "@kubernetes/client-node";
import type { WorkerKubernetesClientV1 } from "./kubernetes-client.js";

const currentPath = "internal/platform/v1/native-metadata/current";
const maximumRequestBytes = 64 * 1024;
const maximumResponseBytes = 64 * 1024;
// Current confirmation shares the original metadata request deadline.
// A shorter default rejects a healthy chain before the request expires.
const transportTimeoutMs = RuntimeNativeMetadataProofMaximumLifetimeMsV1;
const maximumSourceRefLength = 256;
const apiServiceLabel = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const replicaSourceRef =
	/^([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function unavailable(): NativeMetadataCurrentResponseV1 {
	return { outcome: "unavailable" };
}

function currentRequestPayload(value: NativeMetadataCurrentRequestV1) {
	const scope = value.scope;
	return JSON.stringify({
		schemaVersion: value.schemaVersion,
		readId: value.readId,
		selector: value.selector,
		scope: {
			schemaVersion: scope.schemaVersion,
			principal: { kind: scope.principal.kind, id: scope.principal.id },
			agentId: scope.agentId,
			channelId: scope.channelId,
			conversationId: scope.conversationId,
			executionId: scope.executionId,
			sessionGeneration: scope.sessionGeneration,
			authorizationRevision: scope.authorizationRevision,
		},
		readStartedAt: value.readStartedAt,
		expiresAt: value.expiresAt,
		requestId: value.requestId,
		traceId: value.traceId,
		phase: value.phase,
		originalHostScopeRef: value.originalHostScopeRef,
	});
}

export interface PlatformApiNativeMetadataCurrentClientOptionsV1 {
	readonly baseUrl: string;
	readonly serviceToken: string;
	readonly fetch?: typeof fetch;
	readonly transportTimeoutMs?: number;
	readonly replicas?: Pick<WorkerKubernetesClientV1, "read" | "namespace">;
}

/** Resolve only a current Pod member of the deployment-configured API Service. */
async function resolveReplicaOrigin(
	replicas: NonNullable<
		PlatformApiNativeMetadataCurrentClientOptionsV1["replicas"]
	>,
	serviceName: string,
	sourceRef: string,
	signal: AbortSignal,
) {
	const match = replicaSourceRef.exec(sourceRef);
	const uid = match?.[1];
	if (!uid || signal.aborted) return undefined;
	const endpoints = await replicas.read<V1Endpoints>("Endpoints", serviceName);
	if (
		signal.aborted ||
		endpoints?.metadata?.namespace !== replicas.namespace ||
		endpoints.metadata.name !== serviceName ||
		endpoints.metadata.deletionTimestamp
	)
		return undefined;
	const matches = (endpoints.subsets ?? []).flatMap((subset) => {
		if (
			!subset.ports?.some(
				(port) =>
					port.name === "http" &&
					port.port === 3000 &&
					(port.protocol ?? "TCP") === "TCP",
			)
		)
			return [];
		return (subset.addresses ?? []).filter(
			(address) => address.targetRef?.uid === uid,
		);
	});
	const address = matches[0];
	const target = address?.targetRef;
	if (
		matches.length !== 1 ||
		target?.kind !== "Pod" ||
		target.namespace !== replicas.namespace ||
		!target.name ||
		!/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/.test(target.name) ||
		!address?.ip ||
		!isIP(address.ip)
	)
		return undefined;
	const pod = await replicas.read<V1Pod>("Pod", target.name);
	if (
		signal.aborted ||
		pod?.metadata?.uid !== uid ||
		pod.metadata.name !== target.name ||
		pod.metadata.namespace !== replicas.namespace ||
		pod.metadata.labels?.["app.kubernetes.io/component"] !== "platform-api" ||
		pod.metadata.deletionTimestamp ||
		pod.status?.podIP !== address.ip ||
		!pod.status.conditions?.some(
			(condition) => condition.type === "Ready" && condition.status === "True",
		)
	)
		return undefined;
	const ip = isIP(address.ip) === 6 ? `[${address.ip}]` : address.ip;
	return `http://${ip}:3000`;
}

/**
 * Authenticated Worker → Platform API current-confirmation transport.
 *
 * The Platform API origin and service token are deployment inputs. The
 * request itself can only carry the already bound current-confirmation DTO;
 * it cannot select an origin, identity or authorization material.
 */
export function createPlatformApiNativeMetadataCurrentClientV1(
	options: PlatformApiNativeMetadataCurrentClientOptionsV1,
) {
	const makePost = (baseUrl: string) =>
		createNativeMetadataJsonTransport({
			...options,
			baseUrl,
			peer: "Platform API",
			path: currentPath,
			maximumResponseBytes,
			strictJson: true,
		});
	const postFixed = makePost(options.baseUrl);
	const origin = new URL(options.baseUrl);
	const serviceName = origin.hostname.split(".")[0] ?? "";
	if (
		options.replicas &&
		(origin.port !== "3000" ||
			!apiServiceLabel.test(serviceName) ||
			![
				serviceName,
				`${serviceName}.${options.replicas.namespace}.svc`,
			].includes(origin.hostname))
	)
		throw new TypeError("Platform API replica Service is invalid");
	const timeoutMs = options.transportTimeoutMs ?? transportTimeoutMs;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
		throw new TypeError("Platform API transport timeout is invalid");
	return {
		async check(input: {
			readonly request: NativeMetadataCurrentRequestV1;
			readonly apiRequestSourceRef: string;
			readonly signal?: AbortSignal;
		}): Promise<NativeMetadataCurrentResponseV1> {
			if (input.signal?.aborted) return unavailable();
			let request: NativeMetadataCurrentRequestV1;
			if (
				typeof input.apiRequestSourceRef !== "string" ||
				input.apiRequestSourceRef.length < 1 ||
				input.apiRequestSourceRef.length > maximumSourceRefLength
			)
				return unavailable();
			try {
				request = NativeMetadataCurrentRequestV1Schema.parse(input.request);
			} catch {
				return unavailable();
			}
			const body = JSON.stringify({
				apiRequestSourceRef: input.apiRequestSourceRef,
				request,
			});
			if (Buffer.byteLength(body, "utf8") > maximumRequestBytes)
				return unavailable();
			const requestTimeoutMs = Math.min(
				RuntimeNativeMetadataProofMaximumLifetimeMsV1,
				timeoutMs,
				Math.max(0, request.expiresAt - Date.now()),
			);
			if (requestTimeoutMs < 1) return unavailable();
			const signal = input.signal
				? AbortSignal.any([input.signal, AbortSignal.timeout(requestTimeoutMs)])
				: AbortSignal.timeout(requestTimeoutMs);
			try {
				const post = options.replicas
					? await resolveReplicaOrigin(
							options.replicas,
							serviceName,
							input.apiRequestSourceRef,
							signal,
						).then((target) => (target ? makePost(target) : undefined))
					: replicaSourceRef.test(input.apiRequestSourceRef)
						? undefined
						: postFixed;
				if (!post || signal.aborted) {
					logNativeMetadataHop(
						"worker.api-current",
						"replica",
						request.traceId,
						"unavailable",
					);
					return unavailable();
				}
				const response = await post(body, {
					signal,
					traceId: request.traceId,
					allowErrorStatus: true,
					checkAborted: true,
				});
				const result = NativeMetadataCurrentResponseV1Schema.parse(
					response.value,
				);
				if (signal.aborted) return unavailable();
				// An allowed response must come from the authenticated success status;
				// all other statuses remain fail-closed even if their body is shaped
				// like an allowed response.
				if (
					result.outcome === "allowed" &&
					(response.status !== 200 ||
						result.request.phase !== request.phase ||
						currentRequestPayload(result.request) !==
							currentRequestPayload(request))
				)
					return unavailable();
				logNativeMetadataHop(
					"worker.api-current",
					"transport",
					request.traceId,
					result.outcome === "allowed" ? "ok" : "unavailable",
				);
				return result;
			} catch {
				logNativeMetadataHop(
					"worker.api-current",
					"transport",
					request.traceId,
					"unavailable",
				);
				return unavailable();
			}
		},
	};
}
