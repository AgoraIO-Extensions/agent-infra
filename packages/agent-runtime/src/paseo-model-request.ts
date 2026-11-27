import { randomUUID } from "node:crypto";
import type { RuntimeExternalActionAuthorizer } from "./driver.js";
import type { RuntimeMessagesTransportOptions } from "./messages-model-transport.js";
import type { NativeSessionOptions } from "./session-runtime-driver.js";

/** A cold companion waits for signed renewal until its first authorized model request. */
export function createPaseoModelAuthorizer(
	initial: RuntimeExternalActionAuthorizer | undefined,
	ordinary: RuntimeExternalActionAuthorizer,
): RuntimeExternalActionAuthorizer {
	let next = initial ?? ordinary;
	return async (action) => {
		const result = await next(action);
		if (result?.relayKey && result.revalidate) next = ordinary;
		return result ?? undefined;
	};
}

/** Each HTTP operation gets its own durable reference and current execution key. */
export function paseoModelRequest(
	session: NativeSessionOptions,
	authorize: RuntimeExternalActionAuthorizer,
	onEndTurn: () => void,
	onUnknown: () => Promise<void>,
): NonNullable<RuntimeMessagesTransportOptions["openRequest"]> {
	return async (purpose) => {
		const model = session.modelFact?.();
		const write = session.recordOperationFact;
		const executionId = session.executionId;
		if (!model || !write || !executionId)
			throw new Error("RUNTIME_AUTHORIZATION_DENIED");
		const operationRef = randomUUID();
		const attemptRef = randomUUID();
		const fact = { kind: "model" as const, operationRef, attemptRef, model };
		await write({ ...fact, phase: "intent" });
		let revalidate: (() => void) | undefined;
		let startedAt: number | undefined;
		return {
			async resolveCredential() {
				const grant = await authorize({
					kind: "model",
					nativeSessionRef: session.runtimeSessionRef,
					executionId,
					runtimeOperationId: executionId,
					operationRef,
					attemptRef,
				});
				if (!grant?.relayKey || !grant.revalidate)
					throw new Error("RUNTIME_AUTHORIZATION_DENIED");
				revalidate = grant.revalidate;
				return grant.relayKey;
			},
			revalidate() {
				if (!revalidate) throw new Error("RUNTIME_AUTHORIZATION_DENIED");
				revalidate();
			},
			async receipt(state, endTurn, diagnostic) {
				const now = Date.now();
				if (state === "sent") {
					startedAt = now;
					await write({
						...fact,
						phase: "started",
						startedAt: new Date(now).toISOString(),
					});
					return;
				}
				try {
					await write({
						...fact,
						phase: state,
						finishedAt: new Date(now).toISOString(),
						...(startedAt === undefined
							? {}
							: {
									startedAt: new Date(startedAt).toISOString(),
									durationMs: Math.max(0, now - startedAt),
								}),
						...(diagnostic?.usage ? { usage: diagnostic.usage } : {}),
						...(state === "failed"
							? { failureCode: "operation_failed" as const }
							: state === "unknown"
								? { failureCode: "recovery_unconfirmed" as const }
								: {}),
					});
				} finally {
					if (state === "unknown") await onUnknown();
				}
				if (purpose === "main" && state === "completed" && endTurn) onEndTurn();
			},
		};
	};
}
