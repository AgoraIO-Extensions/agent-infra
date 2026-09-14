import type { LiveVerificationEvidence } from "../test-project.ts";
import { capabilityVerificationMatrix } from "../test-project.ts";

export const githubV7VerificationEvidence = {
	actionVersionIds: [
		"github.get_repository@v7",
		"github.create_issue@v7",
		"github.get_issue@v7",
		"github.update_issue@v7",
		"github.create_issue_comment@v7",
		"github.get_issue_comment@v7",
		"github.update_issue_comment@v7",
		"github.delete_issue_comment@v7",
		"github.list_issue_comments@v7",
	],
	cleanup: "SUCCEEDED",
	containerId: "1368335067",
	externalAccount: "328682695",
	provider: "github",
	providerReleaseId:
		"github-openconnector-0cb0e0dd2ed686fa7fa2ff8d9eef97a7d6b31674-connection-v7",
	runId: "34821150745-1",
} as const satisfies LiveVerificationEvidence;

export function verifiedGithubV7ActionVersionIds(catalog: {
	actions: readonly {
		effect: "READ" | "WRITE";
		id: string;
		name: string;
	}[];
	provider: string;
	providerReleaseId: string;
}) {
	try {
		return capabilityVerificationMatrix(catalog, githubV7VerificationEvidence)
			.filter((item) => item.status === "LIVE_VERIFIED")
			.map((item) => item.actionVersionId);
	} catch {
		return [];
	}
}
