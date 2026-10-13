import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
	githubV11ConnectionCatalog,
	OpenConnectorGitHubAdapter,
} from "../packages/openconnector-adapter/src/providers/github/versions/github-v11.ts";

// Read-only developer probe: node tests/github-job-logs-read.mjs OWNER REPO JOB_ID
// Uses the local gh account; this is not Connection OAuth/Grant or production acceptance.
export async function verifyGitHubJobLogs(owner, repo, jobId) {
	const accessToken = execFileSync("gh", ["auth", "token"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
	const adapter = new OpenConnectorGitHubAdapter();
	const read = (startLine) =>
		adapter.execute({
			action: "github.get_workflow_job_logs",
			credential: { accessToken },
			input: { owner, repo, jobId: Number(jobId), startLine, maxLines: 2 },
		});
	const first = await read(1);
	assert.ok(first.text.length > 0, "The chosen Job must have nonempty logs");
	const pages = [first];
	if (first.nextStartLine !== null) {
		const next = await read(first.nextStartLine);
		assert.equal(next.startLine, first.endLine + 1);
		pages.push(next);
	}
	return {
		providerReleaseId: githubV11ConnectionCatalog.providerReleaseId,
		executorDigest: githubV11ConnectionCatalog.executorDigest,
		actionVersionId: "github.get_workflow_job_logs@v11",
		verifiedAt: new Date().toISOString(),
		owner,
		repo,
		jobId: Number(jobId),
		pages: pages.map(({ text, ...metadata }) => ({
			...metadata,
			returnedBytes: Buffer.byteLength(text),
			textDigest: createHash("sha256").update(text).digest("hex"),
		})),
	};
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const [owner, repo, jobId] = process.argv.slice(2);
	if (!owner || !repo || !jobId) {
		console.error(
			"Usage: node tests/github-job-logs-read.mjs OWNER REPO JOB_ID",
		);
		process.exitCode = 1;
	} else {
		try {
			console.log(
				JSON.stringify(await verifyGitHubJobLogs(owner, repo, jobId), null, 2),
			);
		} catch (error) {
			// Never print Provider error bodies, causes, credentials, log text or signed URLs.
			console.error(
				JSON.stringify({
					status: "FAILED",
					providerStatus: error?.providerStatus ?? null,
					reason: "GITHUB_JOB_LOG_READ_PROBE_FAILED",
				}),
			);
			process.exitCode = 1;
		}
	}
}
