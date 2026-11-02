import { randomUUID } from "node:crypto";
import {
	type RuntimeSubmitTurnRequestV4,
	RuntimeAuthorizationRenewRequestV3Schema,
	RuntimeAuthorizationRenewResponseV3Schema,
} from "../../packages/contracts/src/runtime/index.ts";
import { createWorkerRuntimeGrantSignerV2 } from "../../apps/platform-worker/src/runtime-grant-signer.ts";

/** One bounded renewal attempt; the caller owns the event-read loop and abort lifetime. */
export function createTemplateExecutionRenewal(options: {
	request: RuntimeSubmitTurnRequestV4;
	hostSessionRef: string;
	authorizationRecordId: string;
	initialExpiresAt: number;
	signing: Parameters<typeof createWorkerRuntimeGrantSignerV2>[0];
	signal: AbortSignal;
	waitForHostGrant: (grant: { token: string }, signal: AbortSignal) => Promise<void>;
	post: (path: string, body: unknown, signal: AbortSignal) => Promise<unknown>;
	timeoutMs?: number;
}) {
	const now = options.signing.now ?? Date.now;
	const sign = createWorkerRuntimeGrantSignerV2(options.signing);
	const request = structuredClone(options.request);
	const timeoutMs = options.timeoutMs ?? 10_000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000)
		throw new TypeError("Template execution renewal timeout is invalid");
	let renewAt = options.initialExpiresAt - 15_000;
	return async () => {
		options.signal.throwIfAborted();
		if (now() < renewAt) return;
		const unsigned = {
			schemaVersion: 3 as const, requestId: randomUUID(), traceId: request.traceId,
			principal: request.principal, channelId: request.channelId, agentId: request.agentId,
			conversationId: request.conversationId, executionId: request.executionId, turnId: request.turnId,
			sessionGeneration: request.sessionGeneration, hostSessionRef: options.hostSessionRef,
			operation: request.operation,
		};
		const grant = sign(unsigned, { purpose: "business", authorizationRecordId: options.authorizationRecordId }, "execution.renew");
		const body = RuntimeAuthorizationRenewRequestV3Schema.parse({ ...unsigned, grant });
		const timeoutController = new AbortController();
		const renewalSignal = AbortSignal.any([options.signal, timeoutController.signal]);
		const timer = setTimeout(() => timeoutController.abort(new Error("TEMPLATE_EXECUTION_RENEWAL_TIMEOUT")), timeoutMs);
		let abort: (() => void) | undefined;
		try {
			await Promise.race([
				(async () => {
					await options.waitForHostGrant(grant, renewalSignal);
					renewalSignal.throwIfAborted();
					const renewed = RuntimeAuthorizationRenewResponseV3Schema.parse(await options.post("/internal/runtime/v3/authorizations/renew", body, renewalSignal));
					renewalSignal.throwIfAborted();
					if (renewed.executionId !== request.executionId || renewed.expiresAt <= now() || renewed.expiresAt > now() + 30_000) throw new Error("TEMPLATE_EXECUTION_RENEWAL_INVALID");
					renewAt = renewed.expiresAt - 15_000;
				})(),
				new Promise<never>((_resolve, reject) => {
					abort = () => reject(renewalSignal.reason);
					renewalSignal.addEventListener("abort", abort, { once: true });
					if (renewalSignal.aborted) abort();
				}),
			]);
		} finally {
			clearTimeout(timer);
			if (abort) renewalSignal.removeEventListener("abort", abort);
		}
	};
}
