import assert from "node:assert/strict";
import test from "node:test";
import {
	browserConformanceChecks,
	runBrowserConformanceSuite,
} from "./local-real-e2e/browser-conformance-runner.mjs";
import { validateBrowserConformanceReceipt } from "./local-real-e2e/browser-conformance-validation.mjs";

// Published templates-amd64 from Helm revision 134. Only the journey evidence below is synthetic.
const publication = {
	version: "v0.1.2",
	source: {
		repository: "AgoraIO-Extensions/agent-infra",
		sha: "88b03eb488810c09a57138471fb14669fba90432",
		releaseRun: 45845080304,
		attempt: 1,
	},
};
const digests = {
	codex:
		"sha256:1abf319f92662f5c4954f77b4a87707984757619c0c30f9f5fd8b6b39ad5848e",
	claude:
		"sha256:b3bf64317aec8fc490752eef041159e69a874be403506c1b1abe2c9c289c10a2",
	opencode:
		"sha256:5df266f2c08d69a45e0651e44907e8392298c6a3d3ea395d6e1c6ac855a6a131",
	pi: "sha256:810c4f379d9b73d025a92e77744b6312f261b5eb97f07d115b3bedc4e8212dca",
};
const deploymentRelease = {
	...publication,
	manifests: {
		"templates-amd64": {
			schemaVersion: 1,
			commitSha: publication.source.sha,
			platform: "linux/amd64",
			images: Object.fromEntries(
				Object.entries(digests).map(([template, digest]) => [
					template,
					{
						repository: `ghcr.io/agoraio-extensions/agent-infra/agent-runtime-${template}`,
						digest,
					},
				]),
			),
		},
	},
};
const deployment = {
	chromiumVersion: "140.0.7339.0",
	playwrightVersion: "1.63.0",
	capabilityRevision: 7,
};
function observation(template) {
	return {
		template,
		...deployment,
		release: structuredClone(publication),
		imageDigest: digests[template],
		agentHash: "a".repeat(64),
		sessionHash: "b".repeat(64),
		executionHash: "c".repeat(64),
		checks: Object.fromEntries(
			browserConformanceChecks.map((check) => [
				check,
				{ status: "passed", evidenceHash: "d".repeat(64) },
			]),
		),
	};
}
const input = { commit: publication.source.sha, deployment, deploymentRelease };

test("runs and rereads all four revision 134 journeys against their published images", async () => {
	const { receipt, validated } = await runBrowserConformanceSuite({
		...input,
		runTemplate(template, target) {
			assert.deepEqual(target.deployment, {
				...deployment,
				release: publication,
				imageDigest: digests[template],
			});
			return observation(template);
		},
	});
	assert.equal(receipt.schemaVersion, 2);
	assert.deepEqual(
		receipt.templates.map((row) => row.template),
		Object.keys(digests),
	);
	assert.deepEqual(
		receipt.templates.map((row) => row.imageDigest),
		Object.values(digests),
	);
	assert.equal(validated.status, "passed");
	assert.deepEqual(
		validateBrowserConformanceReceipt(
			JSON.parse(JSON.stringify(receipt)),
			deploymentRelease,
		),
		validated,
	);
	assert.equal(validated.templates[1].checks.navigation, "d".repeat(64));
});

test("refuses to label another journey as Pi even when its digest and release match", async () => {
	await assert.rejects(
		runBrowserConformanceSuite({
			...input,
			runTemplate: (name) => ({
				...observation(name),
				template: name === "pi" ? "codex" : name,
			}),
		}),
		/BROWSER_CONFORMANCE_PI_TEMPLATE_DRIFT/,
	);
});

test("requires a trusted publication before starting any new browser journey", async () => {
	let invoked = false;
	await assert.rejects(
		runBrowserConformanceSuite({
			commit: input.commit,
			deployment: { ...deployment, imageDigest: digests.codex },
			runTemplate() {
				invoked = true;
				throw new Error("unexpected journey");
			},
		}),
		/release:source/,
	);
	assert.equal(invoked, false);
});

test("saved receipts reject mismatched images and evidence against the independent release", async () => {
	const { receipt } = await runBrowserConformanceSuite({
		...input,
		runTemplate: observation,
	});
	function rejected(change, ...reasons) {
		const copy = structuredClone(receipt);
		change(copy);
		const result = validateBrowserConformanceReceipt(copy, deploymentRelease);
		assert.equal(result.status, "rejected");
		for (const reason of reasons)
			assert.ok(result.reasons.includes(reason), result.reasons.join(", "));
	}
	rejected((r) => {
		// The receipt's own image map and observed image agree with each other.
		r.deployment.imageDigests.claude = r.templates[1].imageDigest = digests.pi;
	}, "templates.claude:image-digest-drift");
	rejected(
		(r) => {
			[r.templates[0].imageDigest, r.templates[1].imageDigest] = [
				digests.claude,
				digests.codex,
			];
		},
		"templates.codex:image-digest-drift",
		"templates.claude:image-digest-drift",
	);
	rejected((r) => {
		r.templates.pop();
	}, "templates:missing-pi");
	rejected(
		(r) => {
			r.templates[3] = r.templates[0];
		},
		"templates.codex:duplicate-template",
		"templates:missing-pi",
	);
	rejected((r) => {
		r.templates[3].release.source.attempt++;
	}, "templates.pi:release-drift");
	rejected((r) => {
		r.templates[2].release.version = "v0.1.1";
	}, "templates.opencode:release-drift");
	rejected((r) => {
		r.commit = "9".repeat(40);
	}, "release:source");
	rejected((r) => {
		r.templates[1].chromiumVersion = "1.2.3";
	}, "templates.claude:chromium-drift");
	rejected((r) => {
		r.templates[1].playwrightVersion = "1.2.3";
	}, "templates.claude:playwright-drift");
	rejected((r) => {
		r.templates[1].capabilityRevision++;
	}, "templates.claude:capability-drift");
	rejected((r) => {
		r.templates[3].checks.navigation.status = "unknown";
	}, "templates.pi.navigation:unknown");
	rejected((r) => {
		delete r.templates[1].checks.recovery;
	}, "templates.claude.recovery:missing");
	rejected((r) => {
		delete r.templates[0].checks.navigation.evidenceHash;
	}, "templates.codex.navigation:evidence-hash");
	assert.equal(validateBrowserConformanceReceipt(receipt).status, "rejected");
});

test("selects every expected digest from the matching publication before dispatch", async () => {
	for (const [change, reason] of [
		[
			(m) => {
				m.commitSha = "f".repeat(40);
			},
			"release:template-manifest",
		],
		[
			(m) => {
				delete m.images.opencode;
			},
			"release:opencode-image",
		],
		[
			(m) => {
				m.images.claude = m.images.pi;
			},
			"release:claude-image",
		],
		[
			(m) => {
				m.images.extra = m.images.pi;
			},
			"release:templates",
		],
	]) {
		const release = structuredClone(deploymentRelease);
		change(release.manifests["templates-amd64"]);
		await assert.rejects(
			runBrowserConformanceSuite({
				...input,
				deploymentRelease: release,
				runTemplate: () => assert.fail("unexpected journey"),
			}),
			{ message: reason },
		);
	}
});

test("rejects unbounded template output instead of silently dropping it", async () => {
	await assert.rejects(
		runBrowserConformanceSuite({
			...input,
			runTemplate: async (template) => ({
				...observation(template),
				pageBody: "private",
			}),
		}),
		/BROWSER_CONFORMANCE_CODEX_RESULT_UNBOUNDED/,
	);
});

test("rejects deployment tuple drift before producing a receipt", async () => {
	await assert.rejects(
		runBrowserConformanceSuite({
			...input,
			runTemplate: async (template) =>
				template === "claude"
					? {
							...observation(template),
							imageDigest: `sha256:${"f".repeat(64)}`,
						}
					: observation(template),
		}),
		/BROWSER_CONFORMANCE_CLAUDE_TUPLE_DRIFT/,
	);
});

test("rejects sensitive deployment fields before invoking a template", async () => {
	let called = false;
	await assert.rejects(
		runBrowserConformanceSuite({
			...input,
			deployment: { ...deployment, token: "secret" },
			runTemplate: async (template) => {
				called = true;
				return observation(template);
			},
		}),
		/BROWSER_CONFORMANCE_DEPLOYMENT_UNBOUNDED/,
	);
	assert.equal(called, false);
});

test("stops before the next template when the runner is aborted", async () => {
	const controller = new AbortController();
	const order = [];
	await assert.rejects(
		runBrowserConformanceSuite({
			...input,
			signal: controller.signal,
			runTemplate: async (template) => {
				order.push(template);
				controller.abort();
				return observation(template);
			},
		}),
		/aborted/i,
	);
	assert.deepEqual(order, ["codex"]);
});

test("rejects cancellation after the final template callback", async () => {
	const controller = new AbortController();
	await assert.rejects(
		runBrowserConformanceSuite({
			...input,
			signal: controller.signal,
			runTemplate: async (template) => {
				if (template === "pi") controller.abort();
				return observation(template);
			},
		}),
		/aborted/i,
	);
});
