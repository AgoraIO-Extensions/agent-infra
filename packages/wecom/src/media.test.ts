import { randomBytes } from "node:crypto";
import { decryptFile } from "@wecom/aibot-node-sdk";
import { expect, it, vi } from "vitest";
import { downloadWecomMediaV1 } from "./media.js";
import { encryptWecomMediaFixtureV1 } from "./testing.js";

const aesKey = randomBytes(32).toString("base64");
const plain = Buffer.from("%PDF-1.4\nfixture document\n%%EOF\n");
const download = {
	url: "https://download.example.test/media?token=SENTINEL-URL-3227",
	aesKey,
	expiresAt: new Date(Date.now() + 240_000).toISOString(),
};
function respond(
	body: ConstructorParameters<typeof Response>[0],
	init: ResponseInit = {},
): typeof fetch {
	return vi.fn(async () => new Response(body, init)) as unknown as typeof fetch;
}

it("decrypts the fixture with the pinned SDK and returns the response file name", async () => {
	const encrypted = encryptWecomMediaFixtureV1(plain, aesKey);
	// 替身的加密格式与固定 SDK 的 decryptFile 一致。
	expect(decryptFile(encrypted, aesKey)).toEqual(plain);
	const fetch = respond(new Uint8Array(encrypted), {
		headers: {
			"content-disposition":
				"attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf",
		},
	});
	await expect(
		downloadWecomMediaV1({
			download,
			maxBytes: 1024,
			timeoutMs: 5_000,
			fetch,
		}),
	).resolves.toEqual({
		outcome: "downloaded",
		bytes: plain,
		filename: "报告.pdf",
	});
	expect(fetch).toHaveBeenCalledWith(
		new URL(download.url),
		expect.objectContaining({ redirect: "manual", method: "GET" }),
	);
});

it("stops before reading a body whose declared size exceeds the limit", async () => {
	const cancel = vi.fn();
	const body = new ReadableStream({ cancel });
	await expect(
		downloadWecomMediaV1({
			download,
			maxBytes: 16,
			timeoutMs: 5_000,
			fetch: respond(body, { headers: { "content-length": "4096" } }),
		}),
	).resolves.toEqual({ outcome: "too_large" });
	expect(cancel).toHaveBeenCalled();
});

it("cancels a streamed body as soon as it passes the bound", async () => {
	let pulled = 0;
	const cancel = vi.fn();
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			pulled++;
			controller.enqueue(new Uint8Array(64));
		},
		cancel,
	});
	await expect(
		downloadWecomMediaV1({
			download,
			maxBytes: 100,
			timeoutMs: 5_000,
			fetch: respond(body),
		}),
	).resolves.toEqual({ outcome: "too_large" });
	expect(cancel).toHaveBeenCalled();
	expect(pulled).toBeLessThan(5);
});

it("rejects decrypted content above the limit", async () => {
	const encrypted = encryptWecomMediaFixtureV1(Buffer.alloc(100, 1), aesKey);
	await expect(
		downloadWecomMediaV1({
			download,
			maxBytes: 90,
			timeoutMs: 5_000,
			fetch: respond(new Uint8Array(encrypted)),
		}),
	).resolves.toEqual({ outcome: "too_large" });
});

it("does not download an expired address", async () => {
	const fetch = respond("never");
	await expect(
		downloadWecomMediaV1({
			download: {
				...download,
				expiresAt: new Date(Date.now() - 1).toISOString(),
			},
			maxBytes: 1024,
			timeoutMs: 5_000,
			fetch,
		}),
	).resolves.toEqual({ outcome: "expired" });
	expect(fetch).not.toHaveBeenCalled();
});

it.each([
	["a time limit before the address expires", 4_000, 50, "failed"],
	["the address expiry", 60, 5_000, "expired"],
] as const)(
	"aborts a stalled download at %s",
	async (_name, validMs, timeoutMs, outcome) => {
		// 注入可控时钟：abort 时才把时间推进到计划的等待上限（超时或剩余有效期），
		// 使 expired/failed 判定不依赖真实定时器在毫秒边界上的抖动。
		const started = 1_750_000_000_000;
		let elapsed = 0;
		const stalled = vi.fn(
			(_url: URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						elapsed = Math.min(timeoutMs, validMs);
						reject(new Error("aborted"));
					});
				}),
		);
		await expect(
			downloadWecomMediaV1({
				download: {
					...download,
					expiresAt: new Date(started + validMs).toISOString(),
				},
				maxBytes: 1024,
				timeoutMs,
				now: () => started + elapsed,
				fetch: stalled as unknown as typeof fetch,
			}),
		).resolves.toEqual({ outcome });
	},
);

it("folds provider errors and decryption failures into a fixed result", async () => {
	for (const fetch of [
		respond("SENTINEL-URL-3227 provider error", { status: 403 }),
		respond(new Uint8Array(randomBytes(48))),
		respond(null, { status: 204 }),
	]) {
		const result = await downloadWecomMediaV1({
			download,
			maxBytes: 1024,
			timeoutMs: 5_000,
			fetch,
		});
		expect(result).toEqual({ outcome: "failed" });
		expect(JSON.stringify(result)).not.toContain("SENTINEL");
	}
	await expect(
		downloadWecomMediaV1({
			download: { ...download, aesKey: "short" },
			maxBytes: 1024,
			timeoutMs: 5_000,
			fetch: respond("never"),
		}),
	).resolves.toEqual({ outcome: "failed" });
});

it("follows a bounded number of HTTPS redirects and refuses a downgrade", async () => {
	const encrypted = encryptWecomMediaFixtureV1(plain, aesKey);
	const redirect = (location: string) =>
		new Response(null, { status: 302, headers: { location } });
	const followed = vi
		.fn()
		.mockResolvedValueOnce(redirect("https://cdn.example.test/object"))
		.mockResolvedValueOnce(new Response(new Uint8Array(encrypted)));
	await expect(
		downloadWecomMediaV1({
			download,
			maxBytes: 1024,
			timeoutMs: 5_000,
			fetch: followed as unknown as typeof fetch,
		}),
	).resolves.toMatchObject({ outcome: "downloaded", bytes: plain });
	expect(followed.mock.calls[1]?.[0]).toEqual(
		new URL("https://cdn.example.test/object"),
	);
	const downgraded = vi
		.fn()
		.mockResolvedValueOnce(redirect("http://cdn.example.test/object"));
	await expect(
		downloadWecomMediaV1({
			download,
			maxBytes: 1024,
			timeoutMs: 5_000,
			fetch: downgraded as unknown as typeof fetch,
		}),
	).resolves.toEqual({ outcome: "failed" });
	expect(downgraded).toHaveBeenCalledTimes(1);
	const looping = vi.fn(async () => redirect("https://cdn.example.test/loop"));
	await expect(
		downloadWecomMediaV1({
			download,
			maxBytes: 1024,
			timeoutMs: 5_000,
			fetch: looping as unknown as typeof fetch,
		}),
	).resolves.toEqual({ outcome: "failed" });
	expect(looping).toHaveBeenCalledTimes(4);
});

it.each([
	["an IPv4 literal", "https://10.0.0.8/media"],
	["an IPv6 literal", "https://[fd00::1]/media"],
	["a cluster service", "https://platform-api.platform.svc/media"],
	["a cluster FQDN", "https://platform-api.platform.svc.cluster.local/media"],
	["localhost", "https://localhost/media"],
	["a single-label host", "https://intranet/media"],
	["credentials", "https://user:secret@download.example.test/media"],
])(
	"refuses %s as the first address or a redirect target",
	async (_name, target) => {
		const encrypted = encryptWecomMediaFixtureV1(plain, aesKey);
		const direct = vi.fn(async () => new Response(new Uint8Array(encrypted)));
		await expect(
			downloadWecomMediaV1({
				download: { ...download, url: target },
				maxBytes: 1024,
				timeoutMs: 5_000,
				fetch: direct as unknown as typeof fetch,
			}),
		).resolves.toEqual({ outcome: "failed" });
		expect(direct).not.toHaveBeenCalled();
		const redirected = vi.fn(
			async () =>
				new Response(null, { status: 302, headers: { location: target } }),
		);
		await expect(
			downloadWecomMediaV1({
				download,
				maxBytes: 1024,
				timeoutMs: 5_000,
				fetch: redirected as unknown as typeof fetch,
			}),
		).resolves.toEqual({ outcome: "failed" });
		// 重定向目标在发出请求前就被拒绝。
		expect(redirected).toHaveBeenCalledTimes(1);
	},
);

it("keeps every hop inside the deployment-approved download hosts", async () => {
	const encrypted = encryptWecomMediaFixtureV1(plain, aesKey);
	const allowedHosts = ["example.test"];
	const inside = vi
		.fn()
		.mockResolvedValueOnce(
			new Response(null, {
				status: 302,
				headers: { location: "https://cdn.download.example.test/object" },
			}),
		)
		.mockResolvedValueOnce(new Response(new Uint8Array(encrypted)));
	await expect(
		downloadWecomMediaV1({
			download,
			maxBytes: 1024,
			timeoutMs: 5_000,
			allowedHosts,
			fetch: inside as unknown as typeof fetch,
		}),
	).resolves.toMatchObject({ outcome: "downloaded" });
	const outside = vi.fn(
		async () =>
			new Response(null, {
				status: 302,
				headers: { location: "https://attacker.example.org/object" },
			}),
	);
	await expect(
		downloadWecomMediaV1({
			download,
			maxBytes: 1024,
			timeoutMs: 5_000,
			allowedHosts,
			fetch: outside as unknown as typeof fetch,
		}),
	).resolves.toEqual({ outcome: "failed" });
	expect(outside).toHaveBeenCalledTimes(1);
	const lookalike = vi.fn();
	await expect(
		downloadWecomMediaV1({
			download: { ...download, url: "https://notexample.test/media" },
			maxBytes: 1024,
			timeoutMs: 5_000,
			allowedHosts,
			fetch: lookalike as unknown as typeof fetch,
		}),
	).resolves.toEqual({ outcome: "failed" });
	expect(lookalike).not.toHaveBeenCalled();
});
