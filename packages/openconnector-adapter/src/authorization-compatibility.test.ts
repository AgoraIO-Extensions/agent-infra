import assert from "node:assert/strict";
import test from "node:test";
import {
	datalegoAuthorizationCompatibility,
	datalegoV5ConnectionCatalog,
	datalegoV6AuthorizationCompatibility,
	datalegoV6ConnectionCatalog,
} from "./authorization-compatibility.ts";
import { datalegoV4ConnectionCatalog } from "./datalego-v4.ts";
import { datalegoV5ConnectionCatalog as immutableV5 } from "./datalego-v5.ts";
import { datalegoV6ConnectionCatalog as immutableV6 } from "./datalego-v6.ts";

test("DataLego repair evidence pins the exact unchanged authorization boundary", () => {
	const proof = datalegoAuthorizationCompatibility[0];
	assert.equal(
		proof.fromReleaseId,
		datalegoV4ConnectionCatalog.providerReleaseId,
	);
	assert.equal(
		proof.fromExecutorDigest,
		datalegoV4ConnectionCatalog.executorDigest,
	);
	assert.equal(proof.toReleaseId, immutableV5.providerReleaseId);
	assert.equal(proof.toExecutorDigest, immutableV5.executorDigest);
	assert.deepEqual(
		datalegoV5ConnectionCatalog.authProfile,
		datalegoV4ConnectionCatalog.authProfile,
	);
	assert.deepEqual(
		datalegoV5ConnectionCatalog.deploymentProfile,
		datalegoV4ConnectionCatalog.deploymentProfile,
	);
	assert.deepEqual(
		datalegoV5ConnectionCatalog.actions.map(({ id, ...action }) => action),
		datalegoV4ConnectionCatalog.actions.map(({ id, ...action }) => action),
	);
	assert.deepEqual(datalegoV5ConnectionCatalog.authorizationCompatibility, [
		proof,
	]);
	assert.equal(
		proof.reviewReference,
		"https://github.com/AgoraIO-Extensions/agent-infra/pull/1228",
	);
});

test("v6 evidence preserves only the original four Action boundaries", () => {
	const proof = datalegoV6AuthorizationCompatibility[0];
	assert.equal(proof.fromReleaseId, immutableV5.providerReleaseId);
	assert.equal(proof.fromExecutorDigest, immutableV5.executorDigest);
	assert.equal(proof.toReleaseId, immutableV6.providerReleaseId);
	assert.equal(proof.toExecutorDigest, immutableV6.executorDigest);
	assert.deepEqual(datalegoV6ConnectionCatalog.authorizationCompatibility, [
		proof,
	]);
	assert.deepEqual(immutableV6.authProfile, immutableV5.authProfile);
	assert.deepEqual(
		immutableV6.deploymentProfile,
		immutableV5.deploymentProfile,
	);
	assert.deepEqual(
		immutableV6.actions.slice(0, 4).map(({ id, ...action }) => action),
		immutableV5.actions.map(({ id, ...action }) => action),
	);
});
