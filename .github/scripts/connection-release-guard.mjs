import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const providers = {
	bitbucket: "packages/openconnector-adapter/src/bitbucket-server.ts",
	confluence: "packages/openconnector-adapter/src/confluence-server.ts",
	github: "packages/openconnector-adapter/src/verification/github-v8.ts",
	jenkins: "packages/openconnector-adapter/src/jenkins.ts",
	jira: "packages/openconnector-adapter/src/jira-server.ts",
};

const git = (...args) =>
	execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export function parseCatalogSource(source) {
	const actionVersions = [...source.matchAll(/@v(\d+)/g)].map((match) => Number(match[1]));
	const releaseVersions = [...source.matchAll(/connection-v(\d+)/g)].map((match) => Number(match[1]));
	if (actionVersions.length === 0) throw new Error("Provider source has no versioned actions");
	return {
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
			parseCatalogSource(git("show", `${ref}:${file}`)),
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
	const baselineIndex = process.argv.indexOf("--baseline");
	if (baselineIndex < 0 || !process.argv[baselineIndex + 1]) throw new Error("--baseline is required");
	git("fetch", "origin", "connection", "--prune");
	const sha = verifyCanonicalSha();
	const rows = compareCatalogs(readCatalog(process.argv[baselineIndex + 1]), readCatalog("HEAD"));
	process.stdout.write(`${JSON.stringify({ sha, rows })}\n${markdownDiff(rows)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().catch((error) => {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	});
}
