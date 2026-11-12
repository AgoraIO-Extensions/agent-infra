#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const sha = /^[a-f0-9]{40}$/u;

const failure = (code, details = {}) => ({
	status: "failed",
	code,
	...details,
});

/**
 * Validate an operator-frozen PR snapshot before giving it to an offline reviewer.
 * This checks shape and exact-head consistency; it cannot prove the snapshot is current or complete.
 */
export function validatePrMaterial({ metadata, diff, ci, comments }) {
	if (!metadata || typeof metadata !== "object")
		return failure("PR_MATERIAL_METADATA_INVALID");
	const sourceHead = metadata.fromRef?.latestCommit;
	const targetHead = metadata.toRef?.latestCommit;
	if (!sha.test(sourceHead ?? "") || !sha.test(targetHead ?? ""))
		return failure("PR_MATERIAL_HEAD_INVALID");
	if (!Number.isSafeInteger(metadata.id) || metadata.id < 1)
		return failure("PR_MATERIAL_ID_INVALID");
	if (typeof metadata.title !== "string" || metadata.title.length === 0)
		return failure("PR_MATERIAL_TITLE_INVALID");
	if (!diff || !Array.isArray(diff.files) || diff.files.length === 0)
		return failure("PR_MATERIAL_DIFF_MISSING");
	const paths = new Set();
	for (const file of diff.files) {
		if (
			!file ||
			typeof file.path !== "string" ||
			file.path.length === 0 ||
			paths.has(file.path)
		)
			return failure("PR_MATERIAL_DIFF_PATH_INVALID");
		paths.add(file.path);
		if (!Array.isArray(file.hunks) || file.hunks.length === 0)
			return failure("PR_MATERIAL_DIFF_HUNKS_MISSING", { path: file.path });
		for (const hunk of file.hunks) {
			if (!Array.isArray(hunk.lines) || hunk.lines.length === 0)
				return failure("PR_MATERIAL_DIFF_LINES_MISSING", { path: file.path });
			if (
				!Number.isSafeInteger(hunk.destination_start) ||
				!Number.isSafeInteger(hunk.source_start)
			)
				return failure("PR_MATERIAL_DIFF_ANCHOR_INVALID", { path: file.path });
			for (const line of hunk.lines) {
				if (
					!line ||
					!["ADDED", "REMOVED", "CONTEXT"].includes(line.type) ||
					typeof line.text !== "string"
				)
					return failure("PR_MATERIAL_DIFF_LINE_INVALID", { path: file.path });
			}
		}
	}
	if (!ci || typeof ci !== "object" || typeof ci.overall_state !== "string")
		return failure("PR_MATERIAL_CI_MISSING");
	if (!Array.isArray(comments)) return failure("PR_MATERIAL_COMMENTS_MISSING");
	return {
		status: "passed",
		code: "PR_MATERIAL_FIXED_SNAPSHOT_SHAPE_READY",
		prId: metadata.id,
		sourceHead,
		targetHead,
		fileCount: diff.files.length,
		commentCount: comments.length,
		ciState: ci.overall_state,
		freshness: "operator-frozen-not-current-proof",
	};
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const [metadataPath, diffPath, ciPath, commentsPath] = process.argv.slice(2);
	if (!metadataPath || !diffPath || !ciPath || !commentsPath)
		throw new Error(
			"Usage: poc-pr-material-preflight.mjs <metadata.json> <diff.json> <ci.json> <comments.json>",
		);
	const value = validatePrMaterial({
		metadata: JSON.parse(readFileSync(metadataPath, "utf8")),
		diff: JSON.parse(readFileSync(diffPath, "utf8")),
		ci: JSON.parse(readFileSync(ciPath, "utf8")),
		comments: JSON.parse(readFileSync(commentsPath, "utf8")),
	});
	process.stdout.write(`${JSON.stringify(value)}\n`);
	if (value.status === "failed") process.exitCode = 1;
}
