import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	assertCanonicalSha,
	compareApprovalFence,
	compareCatalogs,
	parseCatalogSource,
	providerSources,
	readCatalog,
} from "./connection-release-guard.mjs";

const approvalJournal = { entries: [{ tag: "0032_connection_access_approval" }] };

test("checks committed approval protocol across Git refs before a Connection PR merges", () => {
	const temp = mkdtempSync(join(tmpdir(), "connection-approval-guard-"));
	const remote = join(temp, "remote.git");
	const candidate = join(temp, "candidate");
	const hooks = join(temp, "empty-hooks");
	const manifestPath = join(candidate, "packages/connection-contracts/approval-fence.json");
	const journalPath = join(candidate, "migrations/connection/meta/_journal.json");
	const guard = join(dirname(fileURLToPath(import.meta.url)), "connection-release-guard.mjs");
	const git = (...args) => execFileSync("git", args, { cwd: candidate, encoding: "utf8" });
	const commit = (message) => {
		git("add", "-A");
		git("-c", "commit.gpgsign=false", "commit", "-m", message);
	};
	const check = () => spawnSync(process.execPath, [guard, "--approval-baseline", "origin/connection"], {
		cwd: candidate,
		encoding: "utf8",
	});
	try {
		execFileSync("git", ["init", "--bare", remote]);
		execFileSync("git", ["init", candidate]);
		mkdirSync(hooks);
		git("config", "core.hooksPath", hooks);
		git("config", "user.email", "fixture@example.invalid");
		git("config", "user.name", "Approval Guard Fixture");
		mkdirSync(dirname(manifestPath), { recursive: true });
		mkdirSync(dirname(journalPath), { recursive: true });
		writeFileSync(journalPath, JSON.stringify(approvalJournal));
		writeFileSync(manifestPath, JSON.stringify({ protocolVersion: 1, migration: "0032_connection_access_approval" }));
		commit("baseline approval protocol");
		git("branch", "-M", "connection");
		git("remote", "add", "origin", remote);
		git("push", "-u", "origin", "connection");

		writeFileSync(manifestPath, JSON.stringify({ protocolVersion: 2, migration: "0032_connection_access_approval" }));
		commit("upgrade approval protocol");
		const upgrade = check();
		assert.equal(upgrade.status, 0, upgrade.stderr);
		assert.deepEqual(JSON.parse(upgrade.stdout), { approvalFence: { before: 1, after: 2 } });
		git("push", "origin", "connection");

		writeFileSync(manifestPath, JSON.stringify({ protocolVersion: 1, migration: "0032_connection_access_approval" }));
		commit("downgrade approval protocol");
		const downgrade = check();
		assert.equal(downgrade.status, 1);
		assert.match(downgrade.stderr, /Approval protocol downgrade/);

		unlinkSync(manifestPath);
		commit("remove approval protocol");
		const removed = check();
		assert.equal(removed.status, 1);
		assert.match(removed.stderr, /Approval fence cannot be removed/);
	} finally {
		if (temp.startsWith(join(tmpdir(), "connection-approval-guard-"))) {
			rmSync(temp, { recursive: true, force: true });
		}
	}
});

test("requires an approval fence manifest once migration 0032 is present", () => {
	assert.throws(() => compareApprovalFence(null, null, approvalJournal), /manifest is required/);
	assert.deepEqual(compareApprovalFence(null, { protocolVersion: 1, migration: "0032_connection_access_approval" }, approvalJournal), { before: null, after: 1 });
});

test("prevents approval protocol removal and downgrade", () => {
	const baseline = { protocolVersion: 2, migration: "0032_connection_access_approval" };
	assert.throws(() => compareApprovalFence(baseline, null, approvalJournal), /cannot be removed/);
	assert.throws(() => compareApprovalFence(baseline, { ...baseline, protocolVersion: 1 }, approvalJournal), /downgrade/);
	assert.deepEqual(compareApprovalFence(baseline, { ...baseline, protocolVersion: 3 }, approvalJournal), { before: 2, after: 3 });
	assert.throws(() => compareApprovalFence(null, baseline, { entries: [] }), /migration journal/);
});

test("tracks the Rehoboam provider catalog", () => {
	assert.equal(
		providerSources.rehoboam,
		"packages/openconnector-adapter/src/rehoboam.ts",
	);
});

test("tracks the Manhattan provider catalog", () => {
	assert.equal(
		providerSources.manhattan,
		"packages/openconnector-adapter/src/manhattan.ts",
	);
});

test("parses action and provider release versions", () => {
	assert.deepEqual(
		parseCatalogSource('const id = "bitbucket.get@v6"; const release = "connection-v6";'),
		{
			actions: { "bitbucket.get": 6 },
			actionVersion: 6,
			providerReleaseVersion: 6,
		},
	);
});

test("rejects action and provider release downgrades", () => {
	assert.throws(
		() => compareCatalogs({ bitbucket: { actions: { "bitbucket.get": 6 }, actionVersion: 6, providerReleaseVersion: 6 } }, { bitbucket: { actions: { "bitbucket.get": 5 }, actionVersion: 5, providerReleaseVersion: 5 } }),
		/Action version downgrade/,
	);
});

test("accepts monotonic catalog versions", () => {
	assert.equal(
		compareCatalogs({ jira: { actions: { "jira.get": 8 }, actionVersion: 8, providerReleaseVersion: 8 } }, { jira: { actions: { "jira.get": 9 }, actionVersion: 9, providerReleaseVersion: 9 } }).length,
		1,
	);
});

test("reports a newly added provider from a zero baseline", () => {
	assert.deepEqual(
		compareCatalogs({}, {
			manhattan: {
				actions: { "manhattan.get_current_user": 1 },
				actionVersion: 1,
				providerReleaseVersion: 1,
			},
		}),
		[
			{
				provider: "manhattan",
				before: {
					actions: {},
					actionVersion: 0,
					providerReleaseVersion: null,
				},
				after: {
					actions: { "manhattan.get_current_user": 1 },
					actionVersion: 1,
					providerReleaseVersion: 1,
				},
			},
		],
	);
});

test("fails closed when the baseline ref is invalid", () => {
	assert.throws(
		() => readCatalog("definitely-not-a-valid-ref"),
		/Not a valid object name|unknown revision|bad object/i,
	);
});

test("rejects a DataLego catalog downgrade", () => {
	assert.throws(
		() =>
			compareCatalogs(
				{
					datalego: {
						actions: { "datalego.get_current_user": 3 },
						actionVersion: 3,
						providerReleaseVersion: 3,
					},
				},
				{
					datalego: {
						actions: { "datalego.get_current_user": 2 },
						actionVersion: 2,
						providerReleaseVersion: 2,
					},
				},
			),
		/Action version downgrade: datalego\.get_current_user/,
	);
});

test("requires the deployment SHA to equal canonical connection head", () => {
	assert.equal(assertCanonicalSha("abc", "abc"), "abc");
	assert.throws(() => assertCanonicalSha("stale", "current"), /does not equal/);
});

test("rejects removed providers and provider release downgrades", () => {
	assert.throws(
		() => compareCatalogs({ bitbucket: { actions: { "bitbucket.get": 6 }, actionVersion: 6, providerReleaseVersion: 6 } }, {}),
		/Provider removed/,
	);
	assert.throws(
		() => compareCatalogs({ bitbucket: { actions: { "bitbucket.get": 6 }, actionVersion: 6, providerReleaseVersion: 6 } }, { bitbucket: { actions: { "bitbucket.get": 6 }, actionVersion: 6, providerReleaseVersion: 5 } }),
		/Provider release downgrade/,
	);
	assert.throws(
		() => compareCatalogs({ bitbucket: { actions: { "bitbucket.get": 6 }, actionVersion: 6, providerReleaseVersion: 6 } }, { bitbucket: { actions: { "bitbucket.get": 6 }, actionVersion: 6, providerReleaseVersion: null } }),
		/Provider release downgrade.*missing/,
	);
});

test("compares every action instead of only the maximum version", () => {
	const baseline = parseCatalogSource(
		'const ids = ["provider.a@v6", "provider.b@v5"]; const release = "connection-v6";',
	);
	const candidate = parseCatalogSource(
		'const ids = ["provider.a@v6", "provider.b@v4"]; const release = "connection-v6";',
	);
	assert.throws(() => compareCatalogs({ provider: baseline }, { provider: candidate }), /provider\.b v5 -> v4/);
});

test("merges explicit and generated actions and rejects ambiguous shared versions", () => {
	const source = `
		const providerId = "provider";
		const actionSpecs = [{ name: "generated" }] as const;
		const explicit = "provider.explicit@v6";
	`;
	assert.deepEqual(parseCatalogSource(source).actions, {
		"provider.explicit": 6,
		"provider.generated": 6,
	});
	assert.throws(
		() => parseCatalogSource(source.replace("@v6", "@v6 @v5")),
		/ambiguous shared action version/,
	);
});
