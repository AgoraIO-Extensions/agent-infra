import { randomUUID } from "node:crypto";
import {
	type ConnectionConsumerDisableDeliveryV1,
	type ConnectionConsumerDisableIntentV1,
	type ConnectionConsumerRegistrationDeliveryV1,
	type ConnectionConsumerRegistrationIntentV1,
	type ConnectionConsumerRegistrationPolicyV1,
	parseConnectionConsumerDisableDeliveryV1,
	parseConnectionConsumerRegistrationDeliveryV1,
} from "@agent-infra/platform-core";
import {
	createPostgresOutboxStore,
	PostgresConnectionConsumerDisableStoreV1,
	PostgresConnectionConsumerRegistrationStoreV1,
} from "@agent-infra/platform-store";

/** A lifecycle adapter throws this only when the disable POST was certainly never started. */
export const connectionConsumerDisableNotSentV1 = "CONNECTION_DISABLE_NOT_SENT";

/** Private one-shot custody boundary; never part of a delivery/result object. */
export type ConnectionRegistrationCredentialSinkV2 = (
	delivery: Extract<
		ConnectionConsumerRegistrationDeliveryV1,
		{ outcome: "registered" }
	>,
	credential?: Uint8Array,
) => Promise<boolean>;

/** An approved machine adapter must verify the published receipt; this seam has no HTTP default. */
export interface ConnectionConsumerRegistrationAdapterV1 {
	readonly credentialDelivery?: "RESPONSE";
	register(
		intent: ConnectionConsumerRegistrationIntentV1,
		signal: AbortSignal,
		retainCredential?: ConnectionRegistrationCredentialSinkV2,
	): Promise<ConnectionConsumerRegistrationDeliveryV1>;
	/** Unknown attempts only read back the original source key/operation; they never create a replacement. */
	reconcile(
		intent: ConnectionConsumerRegistrationIntentV1,
		signal: AbortSignal,
		retainCredential?: ConnectionRegistrationCredentialSinkV2,
	): Promise<ConnectionConsumerRegistrationDeliveryV1>;
	/** Spec §13.5.7 lifecycle `POST R/disable`; absent means disable intents stay unsent. */
	disable?(
		intent: ConnectionConsumerDisableIntentV1,
		signal: AbortSignal,
	): Promise<ConnectionConsumerDisableDeliveryV1>;
	/** Reads back only the original disable operation; never posts again. */
	reconcileDisable?(
		intent: ConnectionConsumerDisableIntentV1,
		signal: AbortSignal,
	): Promise<ConnectionConsumerDisableDeliveryV1>;
}

export function createConnectionConsumerRegistrationWorkerV1(input: {
	readonly databaseUrl: string;
	readonly policy: ConnectionConsumerRegistrationPolicyV1;
	readonly adapter?: ConnectionConsumerRegistrationAdapterV1;
	/** Approved ADR 0002 encryptor; absent keeps v2 registration unsent. */
	readonly encryptCredential?: import("@agent-infra/platform-core").AgentConnectionAssociationDependenciesV1["encrypt"];
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
	const encryptCredential = input.encryptCredential;
	const store = new PostgresConnectionConsumerRegistrationStoreV1(input);
	const disables = new PostgresConnectionConsumerDisableStoreV1(input);
	const outbox = createPostgresOutboxStore(input);
	const lifecycle =
		typeof input.adapter?.disable === "function" &&
		typeof input.adapter.reconcileDisable === "function"
			? {
					disable: input.adapter.disable.bind(input.adapter),
					reconcile: input.adapter.reconcileDisable.bind(input.adapter),
				}
			: undefined;
	const leaseOwner = `connection-registration:${randomUUID()}`;
	const active = new Set<AbortController>();
	const runs = new Set<Promise<void>>();
	let stopped = false;
	function stop() {
		stopped = true;
		for (const controller of active) controller.abort();
	}
	async function bounded<T>(
		call: (signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		const controller = new AbortController();
		active.add(controller);
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		let cancel: (() => void) | undefined;
		try {
			const aborted = new Promise<never>((_resolve, reject) => {
				cancel = () => reject(new Error("CONNECTION_REGISTRATION_INTERRUPTED"));
				controller.signal.addEventListener("abort", cancel, { once: true });
			});
			return await Promise.race([call(controller.signal), aborted]);
		} finally {
			clearTimeout(timeout);
			if (cancel) controller.signal.removeEventListener("abort", cancel);
			active.delete(controller);
		}
	}
	/** Same outbox loop and lease rules as registration (Spec §13.5.7 Consumer 停用). */
	async function runDisables() {
		for (const itemId of await disables.pending(batchSize)) {
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
			let outcome:
				| "waiting"
				| "pending"
				| "unknown"
				| "disabled"
				| "failed"
				| "not_required" = "unknown";
			let mode: "disable" | "reconcile" | undefined;
			try {
				const attempt = await disables.beginAttempt(
					claim,
					lifecycle !== undefined,
				);
				if (!attempt) continue;
				if (attempt.outcome !== "deliver") outcome = attempt.outcome;
				else if (lifecycle) {
					mode = attempt.mode;
					if (
						!(await outbox.renew({ ...owned, leaseDurationMs })) ||
						!(await disables.current(claim, attempt.mode)) ||
						stopped
					) {
						await disables.deferBeforeSend(claim, attempt.mode);
						outcome = attempt.mode === "disable" ? "pending" : "unknown";
					} else {
						const delivery = parseConnectionConsumerDisableDeliveryV1(
							await bounded((signal) =>
								attempt.mode === "disable"
									? lifecycle.disable(attempt.intent, signal)
									: lifecycle.reconcile(attempt.intent, signal),
							),
							attempt.intent,
						);
						if (await disables.complete(claim, delivery))
							outcome = delivery.outcome;
					}
				}
			} catch (error) {
				if (
					mode === "disable" &&
					error instanceof Error &&
					error.message === connectionConsumerDisableNotSentV1
				) {
					await disables.deferBeforeSend(claim, "disable");
					outcome = "pending";
				}
				// Any other exception after sending cannot establish a deterministic rejection.
				else
					await disables.complete(claim, {
						outcome: "unknown",
						failureCode: "CONNECTION_DISABLE_UNAVAILABLE",
					});
			}
			if (outcome === "disabled" || outcome === "not_required")
				await outbox.markSucceeded(owned);
			else if (outcome === "failed")
				await outbox.markFailed({
					...owned,
					errorCode: "CONNECTION_DISABLE_REJECTED",
				});
			else
				await outbox.scheduleRetry({
					...owned,
					retryDelayMs,
					errorCode:
						outcome === "unknown"
							? "CONNECTION_DISABLE_UNKNOWN"
							: "CONNECTION_DISABLE_PENDING",
				});
		}
	}
	async function runOnce() {
		if (stopped) return;
		await runRegistrations();
		if (stopped) return;
		await runDisables();
	}
	async function runRegistrations() {
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
					input.adapter !== undefined &&
						(input.adapter.credentialDelivery !== "RESPONSE" ||
							encryptCredential !== undefined),
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
							let credentialCommitted = false;
							const retain: ConnectionRegistrationCredentialSinkV2 | undefined =
								encryptCredential
									? async (delivery, credential) => {
											controller.signal.throwIfAborted();
											credentialCommitted = await store.complete(
												claim,
												delivery,
												{
													credential,
													encrypt: encryptCredential,
												},
											);
											return credentialCommitted;
										}
									: undefined;
							const delivery = parseConnectionConsumerRegistrationDeliveryV1(
								await Promise.race([
									attempt.mode === "register"
										? input.adapter.register(
												attempt.intent,
												controller.signal,
												...(retain ? ([retain] as const) : ([] as const)),
											)
										: input.adapter.reconcile(
												attempt.intent,
												controller.signal,
												...(retain ? ([retain] as const) : ([] as const)),
											),
									aborted,
								]),
								attempt.intent,
							);
							if (
								credentialCommitted ||
								(await store.complete(claim, delivery))
							)
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
			await Promise.all([store.close(), disables.close(), outbox.close()]);
		},
	};
}
