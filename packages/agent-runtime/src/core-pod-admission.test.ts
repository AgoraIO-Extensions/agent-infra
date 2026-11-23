import { expect, it, vi } from "vitest";
import {
	admittedCorePod,
	requestCorePodAdmission,
} from "./core-pod-admission.js";

it("requires a fresh kernel result for the expected UID and boot, including after expiry", async () => {
	vi.useFakeTimers();
	try {
		const install = vi.fn(async () => {});
		const host = admittedCorePod("fixture", "pod-a", install);
		let replay: Headers | undefined;
		const transport: typeof fetch = async (_url, init) => {
			const h = new Headers(init?.headers);
			const challenge = h.get("x-core-challenge") ?? "";
			if (h.get("authorization") !== "Bearer " + host.probeToken(challenge))
				return new Response(null, { status: 401 });
			const { token, proof } = await host.issue(challenge);
			const headers = new Headers({
				"x-core-admission": token,
				"x-core-proof": proof,
			});
			const result = new Response(null, {
				status: 204,
				headers: replay ?? headers,
			});
			replay = headers;
			return result;
		};
		const probe = (uid: string) =>
			requestCorePodAdmission(
				"http://fixture.invalid",
				"fixture",
				uid,
				transport,
			);
		install.mockRejectedValueOnce(new Error("kernel refused ruleset"));
		await expect(probe("pod-a")).rejects.toThrow();
		const permit = await probe("pod-a");
		expect(host.accepts(permit)).toBe(true);
		expect(admittedCorePod("fixture", "pod-a", install).accepts(permit)).toBe(
			false,
		);
		await expect(probe("pod-b")).rejects.toThrow();
		await expect(probe("pod-a")).rejects.toThrow();
		vi.advanceTimersByTime(60_001);
		expect(host.accepts(permit)).toBe(false);
		await expect(probe("pod-a")).rejects.toThrow();
		expect(install).toHaveBeenCalledTimes(3);
	} finally {
		vi.useRealTimers();
	}
});
