import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const providerSources = {
	bitbucket: "packages/openconnector-adapter/src/bitbucket-server.ts",
	confluence: "packages/openconnector-adapter/src/confluence-server.ts",
	datalego: "packages/openconnector-adapter/src/datalego.ts",
	github: "packages/openconnector-adapter/src/verification/github-v8.ts",
	jenkins: "packages/openconnector-adapter/src/jenkins.ts",
	jira: "packages/openconnector-adapter/src/jira-server.ts",
	manhattan: "packages/openconnector-adapter/src/manhattan.ts",
	rehoboam: "packages/openconnector-adapter/src/rehoboam.ts",
};

const git = (...args) =>
	execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

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
	for (const provider of Object.keys(baseline)) {
		if (!candidate[provider]) throw new Error(`Provider removed: ${provider}`);
	}
	for (const provider of Object.keys(candidate).sort()) {
		const before = baseline[provider] ?? {
			actions: {},
			actionVersion: 0,
			providerReleaseVersion: null,
		};
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
	const catalog = {};
	for (const [provider, file] of Object.entries(providerSources)) {
		try {
			catalog[provider] = parseCatalogSource(git("show", `${ref}:${file}`), provider);
		} catch (error) {
			if (error?.status === 128) continue;
			throw error;
		}
	}
	return catalog;
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
