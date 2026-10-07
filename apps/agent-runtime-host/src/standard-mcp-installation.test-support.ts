import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StandardMcpInput } from "@agent-infra/agent-runtime";
import type { ApprovedConnectionConsumerTargetV1 } from "@agent-infra/contracts/connection-consumer-profile";
import {
	standardMcpInstallationKey,
	standardMcpMaterialKey,
} from "./standard-mcp-input.js";
import { standardMcpExportKey } from "./standard-mcp-installation.js";

/** Controlled export producer only; no deployed supplier or token acceptance. */
export async function writeStandardMcpExport(
	dataDirectory: string,
	target: ApprovedConnectionConsumerTargetV1,
	inputs: readonly StandardMcpInput[],
	supplyRevision = "r1",
) {
	const delivery = {
		ref: "fixture-protected-supply",
		revision: supplyRevision,
	};
	const root = join(dataDirectory, "codex-driver.json.native", "conversations");
	const source = join(
		root,
		"standard-mcp-export",
		standardMcpExportKey(delivery.ref, delivery.revision),
	);
	await mkdir(join(source, "bindings"), { recursive: true, mode: 0o700 });
	await mkdir(join(source, "materials"), { mode: 0o700 });
	const records = [];
	for (const input of inputs) {
		const { scope, token, ...fields } = input;
		const metadata = { ...fields, agentId: scope.agentId };
		const key = standardMcpInstallationKey(
			input.principal,
			scope.agentId,
			target,
		);
		const material = standardMcpMaterialKey(
			key,
			input.credentialRef,
			input.credentialRevision,
		);
		const metadataPath = join(source, "bindings", `${key}.json`);
		const materialPath = join(source, "materials", `${material}.token`);
		await writeFile(metadataPath, JSON.stringify(metadata), { mode: 0o600 });
		await writeFile(materialPath, token, { mode: 0o400 });
		records.push({ key, material, metadata, metadataPath, materialPath });
	}
	const manifest = {
		schemaVersion: 1,
		delivery,
		configFingerprint: target.configFingerprint,
		source: target.source,
		installationKeys: records.map((record) => record.key),
	};
	const manifestPath = join(source, "manifest.json");
	await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
	const record = records[0];
	if (!record) throw new Error("Missing controlled export input");
	return {
		record,
		source,
		inputDirectory: join(root, "standard-mcp-input"),
		records,
		manifest,
		manifestPath,
		revision: JSON.stringify([delivery.ref, delivery.revision]),
	};
}
