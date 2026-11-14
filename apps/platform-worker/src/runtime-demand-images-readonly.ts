import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
	openPostgresWorkloadStateReaderV1,
	PostgresAgentConfigurationQueryV1,
	PostgresAgentManagementQueryV1,
} from "@agent-infra/platform-store";
import {
	collectRuntimeDemandImagesV1,
	type RuntimeDemandImageContextV1,
	type RuntimeDemandImageProjectionV1,
} from "./runtime-demand-images.js";

async function privateJson(path: string) {
	const handle = await open(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const stat = await handle.stat();
		if (
			!stat.isFile() ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & 0o077) !== 0 ||
			stat.size > 1024 * 1024
		)
			throw new Error("RUNTIME_DEMAND_IMAGE_INPUT_INVALID");
		const buffer = Buffer.alloc(stat.size + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead !== stat.size)
			throw new Error("RUNTIME_DEMAND_IMAGE_INPUT_INVALID");
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(
				buffer.subarray(0, bytesRead),
			),
		);
	} finally {
		await handle.close();
	}
}

/** Run only inside the already approved API/Store identity; never obtain credentials. */
export async function readRuntimeDemandImages(
	input: {
		readonly actorId: string;
		readonly context: RuntimeDemandImageContextV1;
		readonly projections: readonly RuntimeDemandImageProjectionV1[];
	},
	databaseUrl: string | undefined,
) {
	try {
		if (
			typeof databaseUrl !== "string" ||
			databaseUrl.length === 0 ||
			databaseUrl.length > 8192 ||
			typeof input.actorId !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(input.actorId)
		)
			throw new Error("RUNTIME_DEMAND_IMAGE_INPUT_INVALID");
		const url = new URL(databaseUrl);
		if (!["postgres:", "postgresql:"].includes(url.protocol))
			throw new Error("RUNTIME_DEMAND_IMAGE_INPUT_INVALID");
		url.searchParams.set(
			"options",
			`${url.searchParams.get("options") ?? ""} -c default_transaction_read_only=on -c statement_timeout=5000`,
		);
		const options = { databaseUrl: url.toString() };
		const management = new PostgresAgentManagementQueryV1(options);
		const configuration = new PostgresAgentConfigurationQueryV1(options);
		const workloads = openPostgresWorkloadStateReaderV1(options);
		try {
			return await collectRuntimeDemandImagesV1(
				{
					list: (afterId) =>
						management.listAgents(
							{ kind: "administrator" },
							{ limit: 100, ...(afterId ? { afterId } : {}) },
						),
					read: async (agentId) => {
						const agent = await management.getAgent(
							{ kind: "administrator" },
							agentId,
						);
						const result = await configuration.read({
							agentId,
							actorId: input.actorId,
							isAdministrator: true,
							organizationIds: [],
							intent: "manage",
						});
						if (!agent || result.outcome !== "found")
							throw new Error("RUNTIME_DEMAND_IMAGE_READ_UNAVAILABLE");
						return {
							management: agent.management,
							configuration: result.configuration,
							state: await workloads.readCurrentState(agentId),
						};
					},
				},
				input,
			);
		} finally {
			await Promise.allSettled([
				management.close(),
				configuration.close(),
				workloads.close(),
			]);
		}
	} catch {
		throw new Error("RUNTIME_DEMAND_IMAGE_READ_FAILED");
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		const [inputPath, outputPath] = process.argv.slice(2);
		if (!inputPath || !outputPath)
			throw new Error("RUNTIME_DEMAND_IMAGE_INPUT_INVALID");
		const receipt = await readRuntimeDemandImages(
			await privateJson(inputPath),
			process.env.PLATFORM_DATABASE_URL,
		);
		await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, {
			mode: 0o600,
			flag: "wx",
		});
		console.info(
			JSON.stringify({
				status: "PARTIAL",
				agentCount: receipt.rows.length,
				paginationComplete: receipt.paginationComplete,
				contextStable: receipt.contextStable,
			}),
		);
	} catch {
		console.error("RUNTIME_DEMAND_IMAGE_READ_FAILED");
		process.exitCode = 1;
	}
}
