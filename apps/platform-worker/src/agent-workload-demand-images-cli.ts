import { pathToFileURL } from "node:url";

const maximumRequestBytes = 64 * 1024;
const stableCodes = new Set([
	"WORKER_AGENT_WORKLOAD_IMAGE_REQUEST_INVALID",
	"WORKER_AGENT_WORKLOAD_IMAGE_AUTHORITY_UNAVAILABLE",
	"WORKER_AGENT_WORKLOAD_IMAGE_READ_FAILED",
	"WORKER_AGENT_WORKLOAD_IMAGE_PRODUCER_UNAVAILABLE",
]);

/**
 * Normal operator entry for one read-only predicted Agent Workload image
 * receipt. It runs with the Worker's own deployment module, reads one JSON
 * request from stdin and returns only the receipt; errors are stable codes.
 */
export async function runWorkerAgentWorkloadDemandImagesCliV1(io: {
	readonly stdin: AsyncIterable<Uint8Array | string>;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly importModule?: (
		specifier: string,
	) => Promise<Record<string, unknown>>;
}): Promise<
	| { readonly ok: true; readonly output: string }
	| {
			readonly ok: false;
			readonly code: string;
	  }
> {
	let code = "WORKER_AGENT_WORKLOAD_IMAGE_REQUEST_INVALID";
	try {
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of io.stdin) {
			const bytes = Buffer.from(chunk);
			size += bytes.length;
			if (size > maximumRequestBytes) throw new Error();
			chunks.push(bytes);
		}
		const request: unknown = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
		);
		code = "WORKER_AGENT_WORKLOAD_IMAGE_PRODUCER_UNAVAILABLE";
		const specifier = io.env.PLATFORM_WORKER_DEPLOYMENT_MODULE;
		if (
			typeof specifier !== "string" ||
			new URL(specifier).protocol !== "file:"
		)
			throw new Error();
		const entry = await (io.importModule ?? ((value) => import(value)))(
			specifier,
		);
		const read = entry.readPlatformAgentWorkloadDemandImagesV1;
		if (typeof read !== "function") throw new Error();
		code = "WORKER_AGENT_WORKLOAD_IMAGE_READ_FAILED";
		const receipt = await read(request);
		return {
			ok: true,
			output: `${JSON.stringify({
				...receipt,
				runner: { hostname: io.env.HOSTNAME ?? null },
			})}\n`,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		return { ok: false, code: stableCodes.has(message) ? message : code };
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const result = await runWorkerAgentWorkloadDemandImagesCliV1({
		stdin: process.stdin,
		env: process.env,
	});
	// The deployment module may hold timers or sockets; exit after the flush.
	if (result.ok) process.stdout.write(result.output, () => process.exit(0));
	else process.stderr.write(`${result.code}\n`, () => process.exit(1));
}
