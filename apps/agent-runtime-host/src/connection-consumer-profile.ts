import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { RuntimeHostError } from "@agent-infra/agent-runtime";
import {
	type ApprovedConnectionConsumerProfileV1,
	type ApprovedConnectionConsumerTargetV1,
	resolveApprovedConnectionConsumerProfileV1,
} from "@agent-infra/contracts/connection-consumer-profile";

const maximumProfileBytes = 8192;

export type RuntimeConnectionConsumerProfile =
	| ApprovedConnectionConsumerTargetV1
	| Extract<ApprovedConnectionConsumerProfileV1, { status: "unavailable" }>;

function invalidProfile(): RuntimeConnectionConsumerProfile {
	return { status: "unavailable", schemaVersion: 1, reason: "invalid" };
}

/**
 * Read one deployment-mounted, nonsecret { profile, approval } snapshot.
 * The file is the complete source; individual env fields and request headers
 * cannot supplement it. Updates take effect through deployment restart.
 */
export async function readRuntimeConnectionConsumerProfile(
	filePath: string | undefined,
): Promise<RuntimeConnectionConsumerProfile | undefined> {
	if (filePath === undefined) return undefined;
	if (!isAbsolute(filePath) || resolve(filePath) !== filePath)
		return invalidProfile();
	try {
		// ConfigMap projection symlinks are supported. Reject special files and
		// bound the actual read as well as the initial file size.
		const file = await open(
			filePath,
			constants.O_RDONLY | constants.O_NONBLOCK,
		);
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.size < 1 || stat.size > maximumProfileBytes)
				throw new Error();
			const bytes = Buffer.alloc(maximumProfileBytes + 1);
			let length = 0;
			while (length < bytes.length) {
				const { bytesRead } = await file.read(
					bytes,
					length,
					bytes.length - length,
					length,
				);
				if (bytesRead === 0) break;
				length += bytesRead;
			}
			if (length > maximumProfileBytes) throw new Error();
			const input: unknown = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(
					bytes.subarray(0, length),
				),
			);
			if (
				!input ||
				typeof input !== "object" ||
				Array.isArray(input) ||
				Object.keys(input).sort().join(",") !== "approval,profile"
			)
				throw new Error();
			const snapshot = input as { profile: unknown; approval: unknown };
			const approved = resolveApprovedConnectionConsumerProfileV1(
				snapshot.profile,
				snapshot.approval,
			);
			if (approved.status === "unavailable") return approved;
			const target = {
				...approved,
				url: approved.profile.publicOrigin + approved.profile.mcpPath,
			};
			if (
				Buffer.byteLength(JSON.stringify(target), "utf8") > maximumProfileBytes
			)
				throw new Error();
			return target;
		} finally {
			await file.close();
		}
	} catch {
		// Do not expose file paths, bytes or parser errors in startup failures.
		// A selected but unavailable profile blocks new business while the Host
		// retains its original journal, stop and read-only recovery interfaces.
		return invalidProfile();
	}
}

/** Compare a transport assertion against the local approved deployment snapshot. */
export function assertRuntimeConnectionConsumerHeader(
	header: string | undefined,
	expected: RuntimeConnectionConsumerProfile | undefined,
) {
	if (header === undefined && expected === undefined) return;
	try {
		if (
			expected?.status !== "available" ||
			header === undefined ||
			Buffer.byteLength(header, "utf8") > maximumProfileBytes ||
			!isDeepStrictEqual(JSON.parse(header), expected)
		)
			throw new Error();
	} catch {
		throw new RuntimeHostError(
			"CONNECTION_CONSUMER_PROFILE_UNAVAILABLE",
			"Connection Consumer configuration is unavailable",
			503,
			false,
		);
	}
}
