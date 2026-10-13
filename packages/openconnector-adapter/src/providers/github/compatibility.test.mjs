import assert from "node:assert/strict";
import test from "node:test";
import { compareUpgradePaths } from "../../../../../.github/scripts/provider-upgrade-guard.mjs";
import plans from "../../../provider-upgrade-plans.json" with { type: "json" };
import { releaseSnapshot } from "../../../scripts/provider-release-snapshot.mjs";
import { connectionProviderCatalogs } from "../../provider-catalogs.ts";
import { githubConnectionCatalog as v10Catalog } from "./versions/github-v10.ts";
import { githubConnectionCatalog as legacyCatalog } from "./versions/index.ts";

for (const source of [legacyCatalog, v10Catalog]) {
	test(`actual GitHub ${source.providerReleaseId} to v11 upgrade matches runtime reauthorization and exact evidence`, () => {
		const before = releaseSnapshot([
			{ ...source, credentialUpgradeBehavior: "REAUTHORIZE" },
		]);
		const after = releaseSnapshot(
			connectionProviderCatalogs.filter(
				(catalog) => catalog.provider === "github",
			),
		);
		const transitions = compareUpgradePaths(before, after, plans);
		assert.equal(transitions.length, 1);
		assert.equal(transitions[0].strategy, "REAUTHORIZATION_REQUIRED");
		const incompatible = structuredClone(plans);
		incompatible.transitions.find(
			(plan) =>
				plan.provider === "github" &&
				plan.fromReleaseId === source.providerReleaseId &&
				plan.toReleaseId === after.providers[0].providerReleaseId,
		).strategy = "COMPATIBLE_REPAIR";
		assert.throws(
			() => compareUpgradePaths(before, after, incompatible),
			/disagrees with runtime credential behavior/,
		);
		const missingEvidence = structuredClone(after);
		missingEvidence.providers[0].compatibility = [];
		assert.throws(
			() => compareUpgradePaths(before, missingEvidence, plans),
			/no runtime approval evidence/,
		);
	});
}
