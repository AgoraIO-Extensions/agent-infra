import { describe, expect, it } from "vitest";
import type { WorkerAcceptedExecutionV4 } from "./runtime-host-client.js";
import { keySentinel, runtimeV4Harness } from "./test-support/runtime-v4.js";

describe("Original Runtime Key dependencies during close", () => {
	for (const outcome of ["resolved", "rejected"] as const) {
		it.each([
			"accepted before decrypt",
			"ciphertext",
			"decrypt",
			"accepted after decrypt",
		] as const)(
			`joins the underlying %s dependency when ${outcome}`,
			async (stage) => {
				const h = runtimeV4Harness();
				const entered = Promise.withResolvers<void>();
				const dependency = Promise.withResolvers<void>();
				const plaintext = new TextEncoder().encode(keySentinel);
				async function waitFor<const T>(result: T): Promise<T> {
					entered.resolve();
					await dependency.promise;
					return result;
				}
				if (stage === "accepted before decrypt") {
					h.executionKeys.readAcceptedExecution.mockImplementationOnce(() =>
						waitFor(structuredClone(h.accepted())),
					);
				} else if (stage === "ciphertext") {
					h.executionKeys.readCiphertext.mockImplementationOnce(() =>
						waitFor({ opaque: "encrypted-original" }),
					);
				} else if (stage === "decrypt") {
					h.relayKeyDecryptor.decrypt.mockImplementationOnce(() =>
						waitFor({ outcome: "decrypted", plaintext }),
					);
				} else {
					h.executionKeys.readAcceptedExecution
						.mockImplementationOnce(async () => structuredClone(h.accepted()))
						.mockImplementationOnce(() =>
							waitFor(structuredClone(h.accepted())),
						);
				}
				let dispatch: Promise<unknown> | undefined;
				let closing: Promise<void> | undefined;
				try {
					const reference = await h.authorize();
					dispatch = h.runtime.runtimeHost.dispatch(h.request(reference));
					const interrupted = expect(dispatch).rejects.toThrow();
					await entered.promise;
					let closed = false;
					closing = h.runtime.close().then(() => {
						closed = true;
					});
					await interrupted;
					expect(closed).toBe(false);
					expect(h.fetcher).not.toHaveBeenCalled();
					if (outcome === "resolved") dependency.resolve();
					else dependency.reject(new Error("controlled Key read failure"));
					await closing;
					expect(closed).toBe(true);
					expect(h.fetcher).not.toHaveBeenCalled();
					if (stage === "decrypt" && outcome === "resolved")
						expect(plaintext.every((byte) => byte === 0)).toBe(true);
					await expect(
						h.runtime.runtimeHost.dispatch(h.request(reference)),
					).rejects.toThrow();
					expect(h.fetcher).not.toHaveBeenCalled();
				} finally {
					dependency.resolve();
					await Promise.allSettled([dispatch, closing]);
					await h.runtime.close();
				}
			},
		);
	}
	it("refuses the next Key read when close wins after a resolved projection", async () => {
		const h = runtimeV4Harness();
		const entered = Promise.withResolvers<void>();
		const accepted = Promise.withResolvers<WorkerAcceptedExecutionV4 | null>();
		h.executionKeys.readAcceptedExecution.mockImplementationOnce(() => {
			entered.resolve();
			return accepted.promise;
		});
		let dispatch: Promise<unknown> | undefined;
		try {
			const reference = await h.authorize();
			dispatch = h.runtime.runtimeHost.dispatch(h.request(reference));
			const interrupted = expect(dispatch).rejects.toThrow();
			await entered.promise;
			accepted.resolve(structuredClone(h.accepted()));
			const closing = h.runtime.close();
			await interrupted;
			await closing;
			expect(h.executionKeys.readCiphertext).not.toHaveBeenCalled();
			expect(h.relayKeyDecryptor.decrypt).not.toHaveBeenCalled();
			expect(h.fetcher).not.toHaveBeenCalled();
		} finally {
			accepted.resolve(null);
			await Promise.allSettled([dispatch]);
			await h.runtime.close();
		}
	});
});
