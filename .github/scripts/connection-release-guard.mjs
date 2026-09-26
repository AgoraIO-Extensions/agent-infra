import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const providers = {
	bitbucket: "packages/openconnector-adapter/src/bitbucket-server.ts",
	confluence: "packages/openconnector-adapter/src/confluence-server.ts",
	github: "packages/openconnector-adapter/src/verification/github-v8.ts",
	jenkins: "packages/openconnector-adapter/src/jenkins.ts",
	jira: "packages/openconnector-adapter/src/jira-server.ts",
};
const approvalFencePath = "packages/connection-contracts/approval-fence.json";
const migrationJournalPath = "migrations/connection/meta/_journal.json";

const git = (...args) =>
	execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function gitFileExists(ref, path) {
	try {
		git("cat-file", "-e", `${ref}:${path}`);
		return true;
	} catch {
		return false;
	}
}

export function compareApprovalFence(baseline, candidate, journal) {
	const hasMigration = journal.entries?.some((entry) => entry.tag === "0032_connection_access_approval") === true;
	if (baseline && !candidate) throw new Error("Approval fence cannot be removed");
	if (hasMigration && !candidate) throw new Error("Approval fence manifest is required with migration 0032");
	if (!candidate) return null;
	if (!Number.isSafeInteger(candidate.protocolVersion) || candidate.protocolVersion < 1 ||
		candidate.migration !== "0032_connection_access_approval" || !hasMigration) {
		throw new Error("Approval fence manifest does not match the migration journal");
	}
	if (baseline && candidate.protocolVersion < baseline.protocolVersion) {
		throw new Error(`Approval protocol downgrade: v${baseline.protocolVersion} -> v${candidate.protocolVersion}`);
	}
	return { before: baseline?.protocolVersion ?? null, after: candidate.protocolVersion };
}

function readApprovalFence(ref) {
	return gitFileExists(ref, approvalFencePath)
		? JSON.parse(git("show", `${ref}:${approvalFencePath}`))
		: null;
}

export function parseCatalogSource(source, providerHint) {
	const explicitActions = Object.fromEntries(
		[...source.matchAll(/["'`]([a-z0-9-]+\.[a-z0-9_]+)@v(\d+)["'`]/g)].map(
			(match) => [match[1], Number(match[2])],
		),
	);
	const actionSpecSource = source.match(/const actionSpecs[\s\S]*?\] as const;/)?.[0] ?? "";
	const sharedVersions = new Set(
		[...source.matchAll(/@v(\d+)/g)].map((match) => Number(match[1])),
	);
	const providerId = source.match(/const providerId = ["']([^"']+)["']/)?.[1] ?? providerHint;
	if (actionSpecSource && sharedVersions.size !== 1) {
		throw new Error(`Provider ${providerId} has an ambiguous shared action version`);
	}
	const sharedVersion = sharedVersions.values().next().value ?? 0;
	const dynamicActions = Object.fromEntries(
		[...actionSpecSource.matchAll(/\bname:\s*["']([a-z][a-z0-9_]*)["']/g)].map(
			(match) => [`${providerId}.${match[1]}`, sharedVersion],
		),
	);
	const actions = { ...dynamicActions, ...explicitActions };
	const actionVersions = Object.values(actions);
	const releaseVersions = [...source.matchAll(/connection-v(\d+)/g)].map((match) => Number(match[1]));
	if (actionVersions.length === 0) throw new Error("Provider source has no versioned actions");
	return {
		actions,
		actionVersion: Math.max(...actionVersions),
		providerReleaseVersion: releaseVersions.length ? Math.max(...releaseVersions) : null,
	};
}

export function compareCatalogs(baseline, candidate) {
	const rows = [];
	for (const provider of Object.keys(baseline).sort()) {
		if (!candidate[provider]) throw new Error(`Provider removed: ${provider}`);
		const before = baseline[provider];
		const after = candidate[provider];
		for (const [actionId, beforeVersion] of Object.entries(before.actions)) {
			const afterVersion = after.actions[actionId];
			if (afterVersion === undefined) throw new Error(`Action removed: ${actionId}`);
			if (afterVersion < beforeVersion) {
				throw new Error(`Action version downgrade: ${actionId} v${beforeVersion} -> v${afterVersion}`);
			}
		}
		if (after.actionVersion < before.actionVersion) {
			throw new Error(`Action version downgrade: ${provider} v${before.actionVersion} -> v${after.actionVersion}`);
		}
		if (
			before.providerReleaseVersion !== null &&
			(after.providerReleaseVersion === null ||
				after.providerReleaseVersion < before.providerReleaseVersion)
		) {
			throw new Error(`Provider release downgrade: ${provider} v${before.providerReleaseVersion} -> ${after.providerReleaseVersion === null ? "missing" : `v${after.providerReleaseVersion}`}`);
		}
		rows.push({ provider, before, after });
	}
	return rows;
}

export function readCatalog(ref) {
	return Object.fromEntries(
		Object.entries(providers).map(([provider, file]) => [
			provider,
			parseCatalogSource(git("show", `${ref}:${file}`), provider),
		]),
	);
}

export function assertCanonicalSha(current, canonical, canonicalRef = "origin/connection") {
	if (current !== canonical) {
		throw new Error(`Deployment SHA ${current} does not equal ${canonicalRef} ${canonical}`);
	}
	return current;
}

export function verifyCanonicalSha(currentRef = "HEAD", canonicalRef = "origin/connection") {
	const current = git("rev-parse", currentRef);
	const canonical = git("rev-parse", canonicalRef);
	return assertCanonicalSha(current, canonical, canonicalRef);
}

export function markdownDiff(rows) {
	return [
		"| Provider | Action | Provider release |",
		"| --- | --- | --- |",
		...rows.map(({ provider, before, after }) =>
			`| ${provider} | v${before.actionVersion} -> v${after.actionVersion} | ${before.providerReleaseVersion ?? "n/a"} -> ${after.providerReleaseVersion ?? "n/a"} |`,
		),
	].join("\n");
}

async function main() {
	const approvalBaselineIndex = process.argv.indexOf("--approval-baseline");
	if (approvalBaselineIndex >= 0) {
		const baselineRef = process.argv[approvalBaselineIndex + 1];
		if (!baselineRef) throw new Error("--approval-baseline requires a ref");
		git("fetch", "origin", "connection", "--prune");
		const approvalFence = compareApprovalFence(
			readApprovalFence(baselineRef),
			readApprovalFence("HEAD"),
			JSON.parse(git("show", `HEAD:${migrationJournalPath}`)),
		);
		process.stdout.write(`${JSON.stringify({ approvalFence })}\n`);
		return;
	}
	const baselineIndex = process.argv.indexOf("--baseline");
	if (baselineIndex < 0 || !process.argv[baselineIndex + 1]) throw new Error("--baseline is required");
	git("fetch", "origin", "connection", "--prune");
	const sha = verifyCanonicalSha();
	const rows = compareCatalogs(readCatalog(process.argv[baselineIndex + 1]), readCatalog("HEAD"));
	const approvalFence = compareApprovalFence(
		readApprovalFence(process.argv[baselineIndex + 1]),
		readApprovalFence("HEAD"),
		JSON.parse(git("show", `HEAD:${migrationJournalPath}`)),
	);
	process.stdout.write(`${JSON.stringify({ sha, rows, approvalFence })}\n${markdownDiff(rows)}\nApproval fence: ${approvalFence ? `${approvalFence.before ?? "none"} -> v${approvalFence.after}` : "not enabled"}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().catch((error) => {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	});
}
