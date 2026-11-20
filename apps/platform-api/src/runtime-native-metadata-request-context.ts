import { RuntimeNativeMetadataProofMaximumLifetimeMsV1 } from "@agent-infra/contracts/runtime";
import { createHttpNativeAdmissionTelemetry } from "@agent-infra/observability/http";
import {
	type NativeAdmissionObserverV1,
	observeNativeAdmissionV1,
} from "@agent-infra/platform-core";
import type { IdentityContext } from "./http/identity.js";

export interface RuntimeNativeMetadataRequestContextV1 {
	readonly observeAdmission?: NativeAdmissionObserverV1;
	setAdmissionProtocolVersion?(version: number): void;
	readonly traceId?: string;
	readonly readStartedAt: number;
	readonly expiresAt: number;
	readonly signal: AbortSignal;
	assertCurrent(): void;
	limit(expiresAt: number): void;
	run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T>;
	authenticate(): Promise<IdentityContext>;
	revalidate(identity: IdentityContext): Promise<IdentityContext>;
	beforeDelivery(check: () => Promise<unknown>): void;
	verifyDelivery(identity: IdentityContext): Promise<void>;
	confirmPolicy(
		authority: {
			readonly actorId: string;
			readonly agentId: string;
			readonly channelId: string;
			readonly authorizationRevision: string;
		},
		conversationId: string,
	): void;
	close(): void;
}

/** One original HTTP request owns the deadline, cancellation and authentication source. */
export function createRuntimeNativeMetadataRequestContextV1(options: {
	readonly signal: AbortSignal;
	readonly authenticate: () => Promise<IdentityContext>;
	readonly now?: () => number;
	readonly traceId?: string;
	readonly admissionTelemetry?: boolean;
}): RuntimeNativeMetadataRequestContextV1 {
	const telemetry = options.admissionTelemetry
		? createHttpNativeAdmissionTelemetry()
		: undefined;
	const now = options.now ?? Date.now;
	const readStartedAt = now();
	if (!Number.isSafeInteger(readStartedAt) || readStartedAt < 1)
		throw new TypeError("Native metadata request clock is invalid");
	let expiresAt = readStartedAt + RuntimeNativeMetadataProofMaximumLifetimeMsV1;
	const controller = new AbortController();
	const deliveryChecks = new Set<() => Promise<unknown>>();
	const policyRevisions = new Map<string, string>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const close = () => {
		if (timer !== undefined) clearTimeout(timer);
		options.signal.removeEventListener("abort", clientAbort);
		deliveryChecks.clear();
		policyRevisions.clear();
		controller.abort();
	};
	const clientAbort = () => {
		telemetry?.cancel("client_abort");
		close();
	};
	const onDeadline = () => {
		telemetry?.cancel("internal_deadline");
		close();
	};
	const assertCurrent = () => {
		if (
			options.signal.aborted ||
			controller.signal.aborted ||
			now() >= expiresAt
		) {
			if (options.signal.aborted) telemetry?.cancel("client_abort");
			else if (now() >= expiresAt) telemetry?.cancel("internal_deadline");
			close();
			throw new Error("NATIVE_METADATA_REQUEST_UNAVAILABLE");
		}
	};
	options.signal.addEventListener("abort", clientAbort, { once: true });
	timer = setTimeout(onDeadline, Math.max(0, expiresAt - now()));
	timer.unref();
	if (options.signal.aborted) clientAbort();
	const run = async <T>(work: (signal: AbortSignal) => Promise<T>) => {
		assertCurrent();
		try {
			return await new Promise<T>((resolve, reject) => {
				const abort = () =>
					reject(new Error("NATIVE_METADATA_REQUEST_UNAVAILABLE"));
				controller.signal.addEventListener("abort", abort, { once: true });
				// Observe late results even when a dependency ignores cancellation.
				void Promise.resolve()
					.then(() => {
						assertCurrent();
						return work(controller.signal);
					})
					.then((value) => {
						try {
							assertCurrent();
							resolve(value);
						} catch (error) {
							reject(error);
						}
					}, reject)
					.finally(() => controller.signal.removeEventListener("abort", abort));
			});
		} catch (error) {
			telemetry?.failure(error);
			close();
			throw error;
		}
	};
	let initialIdentity = true;
	const authenticate = () => {
		const stage = initialIdentity ? "identity.initial" : "identity.revalidate";
		initialIdentity = false;
		return observeNativeAdmissionV1(telemetry?.observe, stage, () =>
			run(() => options.authenticate()),
		);
	};
	const revalidate = async (identity: IdentityContext) => {
		const current = await authenticate();
		if (
			current.userId !== identity.userId ||
			current.accountStatus !== "active" ||
			current.authorizationRevision !== identity.authorizationRevision
		) {
			close();
			throw new Error("NATIVE_METADATA_REQUEST_UNAVAILABLE");
		}
		return current;
	};
	return Object.freeze({
		observeAdmission: telemetry?.observe,
		setAdmissionProtocolVersion: (version: number) =>
			telemetry?.protocol(version),
		traceId: options.traceId,
		readStartedAt,
		get expiresAt() {
			return expiresAt;
		},
		signal: controller.signal,
		assertCurrent,
		confirmPolicy(
			authority: {
				readonly actorId: string;
				readonly agentId: string;
				readonly channelId: string;
				readonly authorizationRevision: string;
			},
			conversationId: string,
		) {
			assertCurrent();
			const key = JSON.stringify([
				authority.actorId,
				authority.agentId,
				authority.channelId,
				conversationId,
			]);
			const previous = policyRevisions.get(key);
			if (
				[
					authority.actorId,
					authority.agentId,
					authority.channelId,
					authority.authorizationRevision,
					conversationId,
				].some(
					(value) =>
						typeof value !== "string" ||
						value.length === 0 ||
						value.length > 1024,
				) ||
				(previous !== undefined &&
					previous !== authority.authorizationRevision) ||
				(previous === undefined && policyRevisions.size >= 128)
			) {
				close();
				throw new Error("NATIVE_METADATA_REQUEST_UNAVAILABLE");
			}
			policyRevisions.set(key, authority.authorizationRevision);
		},
		limit(deadline: number) {
			assertCurrent();
			if (
				!Number.isSafeInteger(deadline) ||
				deadline > expiresAt ||
				deadline <= now()
			) {
				close();
				throw new Error("NATIVE_METADATA_REQUEST_UNAVAILABLE");
			}
			expiresAt = deadline;
			if (timer !== undefined) clearTimeout(timer);
			timer = setTimeout(onDeadline, Math.max(0, expiresAt - now()));
			timer.unref();
		},
		run,
		authenticate,
		revalidate,
		beforeDelivery(check: () => Promise<unknown>) {
			assertCurrent();
			if (deliveryChecks.size >= 128) {
				close();
				throw new Error("NATIVE_METADATA_REQUEST_CAPACITY");
			}
			deliveryChecks.add(check);
		},
		async verifyDelivery(identity: IdentityContext) {
			return observeNativeAdmissionV1(
				telemetry?.observe,
				"delivery",
				async () => {
					await revalidate(identity);
					for (const check of deliveryChecks) await run(check);
					await revalidate(identity);
				},
			);
		},
		close,
	});
}
