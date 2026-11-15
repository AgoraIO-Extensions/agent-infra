import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { runWorkerSessionDemandImagesCliV1 } from "./session-demand-images-cli.js";

const moduleSpecifier = "file:///app/dist/deployment.mjs";
const request = { schemaVersion: 1, context: {}, targets: [] };

async function* chunks(...values: (string | Uint8Array)[]) {
	for (const value of values) yield value;
}

let directory: string;
beforeAll(async () => {
	// The entry compares its real module URL with argv[1], as in the image.
	directory = await realpath(
		await mkdtemp(join(tmpdir(), "session-images-cli-")),
	);
});
afterAll(async () => {
	await rm(directory, { recursive: true, force: true });
});

it("passes one stdin request to the Worker deployment module and returns only its receipt", async () => {
	const read = vi.fn(async () => ({ kind: "worker-session-demand-images" }));
	const importModule = vi.fn(async () => ({
		readPlatformSessionDemandImagesV1: read,
	}));
	const result = await runWorkerSessionDemandImagesCliV1({
		stdin: chunks(
			JSON.stringify(request).slice(0, 10),
			JSON.stringify(request).slice(10),
		),
		env: {
			PLATFORM_WORKER_DEPLOYMENT_MODULE: moduleSpecifier,
			HOSTNAME: "agent-infra-worker-0",
		},
		importModule,
	});
	expect(result).toEqual({
		ok: true,
		output: `${JSON.stringify({
			kind: "worker-session-demand-images",
			runner: { hostname: "agent-infra-worker-0" },
		})}\n`,
	});
	expect(importModule).toHaveBeenCalledExactlyOnceWith(moduleSpecifier);
	expect(read).toHaveBeenCalledExactlyOnceWith(request);
});

it("returns stable codes without detail and imports nothing for an unusable request", async () => {
	const importModule = vi.fn(async () => ({}));
	const env = { PLATFORM_WORKER_DEPLOYMENT_MODULE: moduleSpecifier };
	for (const stdin of [
		chunks("{"),
		chunks(Buffer.from([0xff, 0xfe])),
		chunks("x".repeat(64 * 1024 + 1)),
	])
		expect(
			await runWorkerSessionDemandImagesCliV1({ stdin, env, importModule }),
		).toEqual({ ok: false, code: "WORKER_SESSION_IMAGE_REQUEST_INVALID" });
	expect(importModule).not.toHaveBeenCalled();

	for (const value of [
		undefined,
		"https://example.test/deployment.mjs",
		"node:fs",
	])
		expect(
			await runWorkerSessionDemandImagesCliV1({
				stdin: chunks(JSON.stringify(request)),
				env: { PLATFORM_WORKER_DEPLOYMENT_MODULE: value },
				importModule,
			}),
		).toEqual({ ok: false, code: "WORKER_SESSION_IMAGE_PRODUCER_UNAVAILABLE" });
	expect(importModule).not.toHaveBeenCalled();

	// An older deployment module without the export, or a failing module import.
	for (const load of [
		async () => ({ readPlatformSessionReserveDeploymentV1: () => ({}) }),
		async () => {
			throw new Error("private configuration detail");
		},
	])
		expect(
			await runWorkerSessionDemandImagesCliV1({
				stdin: chunks(JSON.stringify(request)),
				env,
				importModule: load,
			}),
		).toEqual({ ok: false, code: "WORKER_SESSION_IMAGE_PRODUCER_UNAVAILABLE" });

	for (const [message, code] of [
		[
			"WORKER_SESSION_IMAGE_AUTHORITY_UNAVAILABLE",
			"WORKER_SESSION_IMAGE_AUTHORITY_UNAVAILABLE",
		],
		[
			"synthetic-deployment-transport-proof",
			"WORKER_SESSION_IMAGE_READ_FAILED",
		],
	])
		expect(
			await runWorkerSessionDemandImagesCliV1({
				stdin: chunks(JSON.stringify(request)),
				env,
				importModule: async () => ({
					readPlatformSessionDemandImagesV1: async () => {
						throw new Error(message);
					},
				}),
			}),
		).toEqual({ ok: false, code });
});

it("runs as a separate process that writes the receipt to stdout and exits despite open handles", async () => {
	const cli = join(directory, "sessionDemandImages.mjs");
	await build({
		entryPoints: [
			new URL("./session-demand-images-cli.ts", import.meta.url).pathname,
		],
		bundle: true,
		platform: "node",
		format: "esm",
		outfile: cli,
	});
	const deployment = join(directory, "deployment.mjs");
	await writeFile(
		deployment,
		`setInterval(() => {}, 60_000);
export async function readPlatformSessionDemandImagesV1(request) {
  return { kind: "worker-session-demand-images", echoed: request.targets.length };
}
`,
	);
	const run = (input: string) =>
		spawnSync(process.execPath, [cli], {
			input,
			encoding: "utf8",
			timeout: 10_000,
			env: {
				PATH: process.env.PATH,
				PLATFORM_WORKER_DEPLOYMENT_MODULE: pathToFileURL(deployment).href,
				HOSTNAME: "worker-pod",
			},
		});
	const ok = run(JSON.stringify({ ...request, targets: [{}] }));
	expect(ok.status).toBe(0);
	expect(ok.stderr).toBe("");
	expect(JSON.parse(ok.stdout)).toEqual({
		kind: "worker-session-demand-images",
		echoed: 1,
		runner: { hostname: "worker-pod" },
	});
	const failed = run("not json");
	expect(failed.status).toBe(1);
	expect(failed.stdout).toBe("");
	expect(failed.stderr).toBe("WORKER_SESSION_IMAGE_REQUEST_INVALID\n");
});
