import { RuntimeNativeMetadataProofMaximumLifetimeMsV1 } from "@agent-infra/contracts/runtime";
import type { IdentityContext } from "./http/identity.js";

export interface RuntimeNativeMetadataRequestContextV1 {
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
}): RuntimeNativeMetadataRequestContextV1 {
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
		options.signal.removeEventListener("abort", close);
		deliveryChecks.clear();
		policyRevisions.clear();
		controller.abort();
	};
	const assertCurrent = () => {
		if (
			options.signal.aborted ||
			controller.signal.aborted ||
			now() >= expiresAt
		) {
			close();
			throw new Error("NATIVE_METADATA_REQUEST_UNAVAILABLE");
		}
	};
	options.signal.addEventListener("abort", close, { once: true });
	timer = setTimeout(close, Math.max(0, expiresAt - now()));
	timer.unref();
	if (options.signal.aborted) close();
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
			close();
			throw error;
		}
	};
	const authenticate = () => run(() => options.authenticate());
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
			timer = setTimeout(close, Math.max(0, expiresAt - now()));
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
			await revalidate(identity);
			for (const check of deliveryChecks) await run(check);
			await revalidate(identity);
		},
		close,
	});
}
