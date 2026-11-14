import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
	openPostgresSessionSandboxImageReaderV1,
	openPostgresWorkloadStateReaderV1,
	openPostgresWorkspaceSnapshotMaterializationReaderV1,
	PostgresAgentConfigurationQueryV1,
	PostgresAgentManagementQueryV1,
} from "@agent-infra/platform-store";
import { projectApprovedDeclaredDemandImagesV1 } from "./declared-demand-images.js";
import {
	collectRuntimeDemandImagesV1,
	type RuntimeDemandImageContextV1,
	type RuntimeDemandImageProjectionV1,
} from "./runtime-demand-images.js";
import { projectSessionDemandImagesV1 } from "./session-demand-images.js";

type SessionImageInputs = Pick<
	Parameters<typeof projectSessionDemandImagesV1>[0],
	"authorities" | "bindings"
>;

async function privateBytes(path: string) {
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
		return buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

async function privateJson(path: string) {
	return JSON.parse(
		new TextDecoder("utf-8", { fatal: true }).decode(await privateBytes(path)),
	);
}

/** Run only inside the already approved API/Store identity; never obtain credentials. */
export async function readRuntimeDemandImages(
	input: {
		readonly actorId: string;
		readonly context: RuntimeDemandImageContextV1;
		readonly projections: readonly RuntimeDemandImageProjectionV1[];
		readonly declared?: {
			readonly path: string;
			readonly sha256: string;
			readonly producerSourceSha: string;
		};
	},
	databaseUrl: string | undefined,
	/** Normal Worker authority stays in process; it is never parsed from the CLI JSON. */
	sessionImageInputs?: SessionImageInputs,
) {
	try {
		if (
			typeof databaseUrl !== "string" ||
			databaseUrl.length === 0 ||
			databaseUrl.length > 8192 ||
			typeof input.actorId !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(input.actorId) ||
			typeof input.context?.namespace !== "string" ||
			!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(input.context.namespace)
		)
			throw new Error("RUNTIME_DEMAND_IMAGE_INPUT_INVALID");
		const url = new URL(databaseUrl);
		if (!["postgres:", "postgresql:"].includes(url.protocol))
			throw new Error("RUNTIME_DEMAND_IMAGE_INPUT_INVALID");
		url.searchParams.set(
			"options",
			`${url.searchParams.get("options") ?? ""} -c default_transaction_read_only=on -c statement_timeout=5000`,
		);
		const declared = input.declared
			? await privateBytes(input.declared.path)
			: null;
		if (declared && input.declared)
			projectApprovedDeclaredDemandImagesV1(declared, {
				...input.declared,
				context: input.context,
				casByKey: {},
			});
		const options = { databaseUrl: url.toString() };
		const management = new PostgresAgentManagementQueryV1(options);
		const configuration = new PostgresAgentConfigurationQueryV1(options);
		const workloads = openPostgresWorkloadStateReaderV1(options);
		const sessionReader = openPostgresSessionSandboxImageReaderV1(options);
		let snapshots:
			| ReturnType<typeof openPostgresWorkspaceSnapshotMaterializationReaderV1>
			| undefined;
		try {
			const receipt = await collectRuntimeDemandImagesV1(
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
			const sessions = await sessionReader.read(input.context.namespace);
			const sessionImages = await projectSessionDemandImagesV1({
				readback: sessions,
				contextHash: receipt.context.contextHash,
				authorities: sessionImageInputs?.authorities ?? [],
				bindings: sessionImageInputs?.bindings ?? [],
				snapshots: {
					read: (snapshotInput) => {
						snapshots ??= openPostgresWorkspaceSnapshotMaterializationReaderV1(
							url.toString(),
						);
						return snapshots.read(snapshotInput);
					},
				},
			});
			const casByKey = Object.fromEntries(
				receipt.rows
					.filter((row) => row.contextStable)
					.map((row) => [row.bindingKey, row.casHash]),
			);
			const eligibleSessions = sessions.items
				.map((item) => item.metadata)
				.filter(
					(row) =>
						row.bindingStatus === "VERIFIED_STORE_COMPOSITE" &&
						row.bindingKey === `session:${row.binding.sandboxId}` &&
						(row.namespace === input.context.namespace ||
							row.retained?.policy.namespace === input.context.namespace),
				);
			for (const row of eligibleSessions) {
				if (Object.hasOwn(casByKey, row.bindingKey))
					throw new Error("RUNTIME_DEMAND_IMAGE_CAS_AMBIGUOUS");
				casByKey[row.bindingKey] = row.casHash;
			}
			return {
				...receipt,
				coverage: {
					...receipt.coverage,
					session: "STORE_METADATA_ENUMERATED_IMAGE_GROUPS_PARTIAL",
					declared: declared
						? "APPROVED_FILE_GROUPS_ONLY"
						: "UNKNOWN_NO_APPROVED_FILE",
				},
				bindingKeys: Object.keys(casByKey).sort(),
				sessionInventory: {
					namespace: sessions.namespace,
					observedAtDatabase: sessions.observedAtDatabase,
					storeSnapshot: sessions.storeSnapshot,
					pageCount: sessions.pageCount,
					enumerationComplete: sessions.enumerationComplete,
					emptyAfterCompleteEnumeration: sessions.emptyAfterCompleteEnumeration,
					scope: sessions.scope,
					rows: sessions.items.map((item) => item.metadata),
				},
				sessionImages,
				snapshotScope:
					"per-Agent double-read and independent Session MVCC snapshot; no single global snapshot claim",
				declared:
					declared && input.declared
						? projectApprovedDeclaredDemandImagesV1(declared, {
								...input.declared,
								context: input.context,
								casByKey,
							})
						: {
								scope: "declared-approved-file",
								status: "UNKNOWN_NO_APPROVED_FILE",
								groups: [],
							},
			};
		} finally {
			await Promise.allSettled([
				management.close(),
				configuration.close(),
				workloads.close(),
				sessionReader.close(),
				...(snapshots ? [snapshots.close()] : []),
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
