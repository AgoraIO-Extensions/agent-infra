import { randomUUID } from "node:crypto";
import {
	type ConnectionConsumerRegistrationDeliveryV1,
	type ConnectionConsumerRegistrationIntentV1,
	type ConnectionConsumerRegistrationPolicyV1,
	parseConnectionConsumerRegistrationDeliveryV1,
} from "@agent-infra/platform-core";
import {
	createPostgresOutboxStore,
	PostgresConnectionConsumerRegistrationStoreV1,
} from "@agent-infra/platform-store";

/** An approved machine adapter must verify the published receipt; this seam has no HTTP default. */
export interface ConnectionConsumerRegistrationAdapterV1 {
	register(
		intent: ConnectionConsumerRegistrationIntentV1,
		signal: AbortSignal,
	): Promise<ConnectionConsumerRegistrationDeliveryV1>;
	/** Unknown attempts only read back the original source key/operation; they never create a replacement. */
	reconcile(
		intent: ConnectionConsumerRegistrationIntentV1,
		signal: AbortSignal,
	): Promise<ConnectionConsumerRegistrationDeliveryV1>;
}

export function createConnectionConsumerRegistrationWorkerV1(input: {
	readonly databaseUrl: string;
	readonly policy: ConnectionConsumerRegistrationPolicyV1;
	readonly adapter?: ConnectionConsumerRegistrationAdapterV1;
	readonly batchSize?: number;
	readonly leaseDurationMs?: number;
	readonly retryDelayMs?: number;
	readonly timeoutMs?: number;
}) {
	const leaseDurationMs = input.leaseDurationMs ?? 30_000;
	const retryDelayMs = input.retryDelayMs ?? 30_000;
	const timeoutMs = input.timeoutMs ?? 10_000;
	const batchSize = input.batchSize ?? 1;
	if (
		!Number.isSafeInteger(leaseDurationMs) ||
		leaseDurationMs < 1 ||
		leaseDurationMs > 60_000 ||
		!Number.isSafeInteger(retryDelayMs) ||
		retryDelayMs < 1 ||
		retryDelayMs > 300_000 ||
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 1 ||
		timeoutMs + 1000 > leaseDurationMs ||
		!Number.isInteger(batchSize) ||
		batchSize < 1 ||
		batchSize > 20
	)
		throw new Error("CONNECTION_CONSUMER_REGISTRATION_INVALID");
	const store = new PostgresConnectionConsumerRegistrationStoreV1(input);
	const outbox = createPostgresOutboxStore(input);
	const leaseOwner = `connection-registration:${randomUUID()}`;
	const active = new Set<AbortController>();
	const runs = new Set<Promise<void>>();
	let stopped = false;
	function stop() {
		stopped = true;
		for (const controller of active) controller.abort();
	}
	async function runOnce() {
		if (stopped) return;
		for (const itemId of await store.pending(batchSize)) {
			if (stopped) return;
			const claim = await outbox.claim({
				itemId,
				leaseOwner,
				leaseDurationMs,
			});
			if (!claim) continue;
			const owned = {
				itemId,
				leaseOwner,
				deliveryFence: claim.deliveryFence,
			};
			let outcome: "registered" | "failed" | "unknown" | "pending" = "unknown";
			try {
				const attempt = await store.beginAttempt(
					claim,
					input.adapter !== undefined,
				);
				if (!attempt) continue;
				if (attempt.outcome !== "deliver") outcome = attempt.outcome;
				else if (attempt.outcome === "deliver" && input.adapter) {
					if (
						!(await outbox.renew({ ...owned, leaseDurationMs })) ||
						!(await store.current(claim)) ||
						stopped
					) {
						await store.deferBeforeSend(claim, attempt.mode);
						outcome = attempt.mode === "register" ? "pending" : "unknown";
					} else {
						const controller = new AbortController();
						active.add(controller);
						const timeout = setTimeout(() => controller.abort(), timeoutMs);
						let cancel: (() => void) | undefined;
						try {
							const aborted = new Promise<never>((_resolve, reject) => {
								cancel = () =>
									reject(new Error("CONNECTION_REGISTRATION_INTERRUPTED"));
								controller.signal.addEventListener("abort", cancel, {
									once: true,
								});
							});
							const delivery = parseConnectionConsumerRegistrationDeliveryV1(
								await Promise.race([
									attempt.mode === "register"
										? input.adapter.register(attempt.intent, controller.signal)
										: input.adapter.reconcile(
												attempt.intent,
												controller.signal,
											),
									aborted,
								]),
								attempt.intent,
							);
							if (await store.complete(claim, delivery))
								outcome = delivery.outcome;
						} finally {
							clearTimeout(timeout);
							if (cancel)
								controller.signal.removeEventListener("abort", cancel);
							active.delete(controller);
						}
					}
				}
			} catch {
				// An exception after sending cannot establish a deterministic rejection.
				await store.complete(claim, {
					outcome: "unknown",
					failureCode: "CONNECTION_REGISTRATION_UNAVAILABLE",
				});
			}
			if (outcome === "registered") await outbox.markSucceeded(owned);
			else if (outcome === "failed")
				await outbox.markFailed({
					...owned,
					errorCode: "CONNECTION_REGISTRATION_REJECTED",
				});
			else
				await outbox.scheduleRetry({
					...owned,
					retryDelayMs,
					errorCode:
						outcome === "pending"
							? "CONNECTION_REGISTRATION_PENDING"
							: "CONNECTION_REGISTRATION_UNKNOWN",
				});
		}
	}
	return {
		runOnce() {
			const run = runOnce();
			runs.add(run);
			run.then(
				() => runs.delete(run),
				() => runs.delete(run),
			);
			return run;
		},
		stop,
		async close() {
			stop();
			await Promise.allSettled([...runs]);
			await Promise.all([store.close(), outbox.close()]);
		},
	};
}
