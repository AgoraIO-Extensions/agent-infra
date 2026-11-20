import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { validateStandardTemplateModelBindingsV1 } from "@agent-infra/model-catalog";
import {
	openPostgresSessionSandboxImageReaderV1,
	openPostgresWorkspaceSnapshotMaterializationReaderV1,
} from "@agent-infra/platform-store";
import type { ConnectionInstallBootstrapDeploymentV1 } from "./connection-install-bootstrap.js";
import {
	type RuntimeDemandImageContextV1,
	runtimeDemandImageContextV1,
} from "./runtime-demand-images.js";
import {
	projectSessionDemandImagesV1,
	readOnlySessionImageDatabaseUrlV1,
	type SessionDemandImageAuthorityV1,
} from "./session-demand-images.js";
import { selectSessionOAuthProvisioningV1 } from "./session-oauth-provisioning-selection.js";
import type { SessionSandboxOAuthProvisioningV1 } from "./session-workload-adapter.js";
import {
	type WorkloadRuntimeOptionsV1,
	workloadResourceConfigurationHashV1,
} from "./workload-runtime.js";

/**
 * The inputs this Worker process's Session receiver uses: the deployment
 * module's own policy, template bindings, snapshot resolver, service token and
 * OAuth provisioning. Callers never supply any of them.
 */
export interface WorkerSessionDemandImageDeploymentV1 {
	/** `PLATFORM_WORKER_NAMESPACE` of this process. */
	readonly namespace: string | undefined;
	/** Deployment signing identity; the policy's runtime auth must name it. */
	readonly workerId: unknown;
	readonly workload: {
		readonly policy: WorkloadRuntimeOptionsV1["policy"];
		readonly templateModelBindings: unknown;
		readonly workspaceSnapshotResolver?: WorkloadRuntimeOptionsV1["workspaceSnapshotResolver"];
	};
	readonly serviceToken: unknown;
	readonly oauthProvisioning?: SessionSandboxOAuthProvisioningV1;
	readonly connectionInstallBootstrap?: ConnectionInstallBootstrapDeploymentV1;
	/** The deployment configuration module this process evaluated. */
	readonly configurationModule: URL;
	/**
	 * Source that produced the mounted deployment configuration, as declared in
	 * its Session reserve file; the caller's context cannot supply it.
	 */
	readonly configurationSourceSha: unknown;
}

const authorityId = "worker-deployment";
const requestKeys = "context,schemaVersion,targets";
const contextKeys = [
	"clusterUid",
	"directoryBindingHash",
	"directorySnapshotHash",
	"helmRevision",
	"installationId",
	"namespace",
	"namespaceUid",
	"planHash",
	"platformSource",
	"release",
	"runtimeAuthority",
].join(",");
const namespacePattern = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const sandboxPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const sourcePattern = /^[a-f0-9]{40}$/;
const hashPattern = /^[a-f0-9]{64}$/;

type Target = {
	readonly sandboxId: string;
	readonly inputHash: string;
	readonly casHash?: string;
};

function plainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRequest(value: unknown) {
	try {
		if (
			!plainObject(value) ||
			Object.keys(value).sort().join(",") !== requestKeys ||
			value.schemaVersion !== 1 ||
			!plainObject(value.context) ||
			Object.keys(value.context).sort().join(",") !== contextKeys ||
			!Array.isArray(value.targets) ||
			value.targets.length < 1 ||
			value.targets.length > 16
		)
			throw new Error();
		const context = runtimeDemandImageContextV1(
			value.context as unknown as RuntimeDemandImageContextV1,
		);
		const targets: Target[] = value.targets.map((target: unknown) => {
			if (
				!plainObject(target) ||
				Object.keys(target).some(
					(key) => !["sandboxId", "inputHash", "casHash"].includes(key),
				) ||
				typeof target.sandboxId !== "string" ||
				!sandboxPattern.test(target.sandboxId) ||
				typeof target.inputHash !== "string" ||
				!hashPattern.test(target.inputHash) ||
				(target.casHash !== undefined &&
					(typeof target.casHash !== "string" ||
						!hashPattern.test(target.casHash)))
			)
				throw new Error();
			return {
				sandboxId: target.sandboxId,
				inputHash: target.inputHash,
				...(target.casHash === undefined ? {} : { casHash: target.casHash }),
			};
		});
		if (
			new Set(targets.map((target) => target.sandboxId)).size !== targets.length
		)
			throw new Error();
		return { context, targets };
	} catch {
		throw new Error("WORKER_SESSION_IMAGE_REQUEST_INVALID");
	}
}

async function deploymentAuthority(
	deployment: WorkerSessionDemandImageDeploymentV1,
	context: ReturnType<typeof runtimeDemandImageContextV1>,
) {
	try {
		const { policy } = deployment.workload;
		const sourceSha = deployment.configurationSourceSha;
		if (
			typeof deployment.namespace !== "string" ||
			!namespacePattern.test(deployment.namespace) ||
			policy?.namespace !== deployment.namespace ||
			context.namespace !== deployment.namespace ||
			typeof deployment.serviceToken !== "string" ||
			deployment.serviceToken.length === 0 ||
			typeof deployment.workerId !== "string" ||
			policy.runtimeAuth?.workerId !== deployment.workerId ||
			// The plan's Runtime/config authority must be the one actually mounted.
			typeof sourceSha !== "string" ||
			!sourcePattern.test(sourceSha) ||
			sourceSha !== context.runtimeAuthority
		)
			throw new Error();
		// The same validated bindings the production Workload options carry.
		const templateModelBindings = validateStandardTemplateModelBindingsV1(
			deployment.workload.templateModelBindings,
		);
		const resourceConfigurationHash =
			workloadResourceConfigurationHashV1(policy);
		const configurationHash = createHash("sha256")
			.update(await readFile(deployment.configurationModule))
			.digest("hex");
		const resolver = deployment.workload.workspaceSnapshotResolver;
		const authority: SessionDemandImageAuthorityV1 = {
			id: authorityId,
			sourceSha,
			configurationHash,
			contextHash: context.contextHash,
			workload: {
				policy,
				templateModelBindings,
				...(resolver ? { workspaceSnapshotResolver: resolver } : {}),
			},
			serviceToken: deployment.serviceToken,
			...(deployment.connectionInstallBootstrap
				? { connectionInstallBootstrap: deployment.connectionInstallBootstrap }
				: {}),
			...(deployment.oauthProvisioning
				? { oauthProvisioning: deployment.oauthProvisioning }
				: {}),
		};
		return {
			authority,
			summary: {
				id: authorityId,
				entry: "deployment readPlatformSessionDemandImagesV1",
				sourceSha,
				sourceShaBinding:
					"mounted session-reserves.json sourceSha; equals context.runtimeAuthority",
				configurationHash,
				configurationHashScope:
					"sha256 of the deployment configuration.mjs bytes this process loaded",
				namespace: deployment.namespace,
				resourceConfigurationHash,
				templateBindingCount: templateModelBindings.length,
				workspaceSnapshotResolver: resolver !== undefined,
				oauthProvisioningConfigured: deployment.oauthProvisioning !== undefined,
			},
		};
	} catch {
		throw new Error("WORKER_SESSION_IMAGE_AUTHORITY_UNAVAILABLE");
	}
}

/**
 * Read-only Session image receipt for explicitly requested allocations, using
 * this Worker's own Session authority. Targets bind by Sandbox and current
 * Store input; the CAS comes from the same read-only snapshot as the images.
 */
export async function readWorkerSessionDemandImagesV1(
	deployment: WorkerSessionDemandImageDeploymentV1,
	request: unknown,
	databaseUrl: string | undefined,
) {
	const { context, targets } = parseRequest(request);
	const { authority, summary } = await deploymentAuthority(deployment, context);
	let reader:
		| ReturnType<typeof openPostgresSessionSandboxImageReaderV1>
		| undefined;
	let snapshots:
		| ReturnType<typeof openPostgresWorkspaceSnapshotMaterializationReaderV1>
		| undefined;
	try {
		const readOnlyUrl = readOnlySessionImageDatabaseUrlV1(databaseUrl);
		reader = openPostgresSessionSandboxImageReaderV1({
			databaseUrl: readOnlyUrl,
		});
		const readback = await reader.read(summary.namespace);
		if (
			readback.namespace !== summary.namespace ||
			readback.enumerationComplete !== true
		)
			throw new Error();
		const bindings: {
			casHash: string;
			inputHash: string;
			authorityId: string;
		}[] = [];
		const targetResults = targets.map((target) => {
			const items = readback.items.filter(
				(item) => item.metadata.binding.sandboxId === target.sandboxId,
			);
			const item = items.length === 1 ? items[0] : undefined;
			if (!item) return { ...target, status: "NOT_FOUND" };
			const casHash = item.metadata.casHash;
			if (target.casHash !== undefined && target.casHash !== casHash)
				return { ...target, observedCasHash: casHash, status: "CAS_CHANGED" };
			const inputs = item
				.workerProjectionInputs()
				.filter((input) => input.inputHash === target.inputHash);
			const input = inputs.length === 1 ? inputs[0] : undefined;
			if (!input)
				return { ...target, observedCasHash: casHash, status: "INPUT_CHANGED" };
			// The OAuth init also depends on Connection publication fields the
			// receiver derives during preparation; this reader does not derive them.
			if (
				selectSessionOAuthProvisioningV1(
					input.binding,
					input.policy.namespace,
					"running",
					deployment.oauthProvisioning,
				)
			)
				return {
					...target,
					observedCasHash: casHash,
					status: "OAUTH_PUBLICATION_UNEVALUATED",
				};
			bindings.push({ casHash, inputHash: target.inputHash, authorityId });
			return { ...target, observedCasHash: casHash, status: "BOUND" };
		});
		const receipt = await projectSessionDemandImagesV1({
			readback,
			contextHash: context.contextHash,
			authorities: [authority],
			bindings,
			snapshots: {
				read: (input) => {
					snapshots ??=
						openPostgresWorkspaceSnapshotMaterializationReaderV1(readOnlyUrl);
					return snapshots.read(input);
				},
			},
		});
		const targetIds = new Set(targets.map((target) => target.sandboxId));
		const rows = receipt.rows
			.filter((row) => targetIds.has(row.binding.sandboxId))
			.map(({ ownerIds, ...row }) => ({ ...row, ownerCount: ownerIds.length }));
		const projected = targetResults.every(
			(target) =>
				target.status === "BOUND" &&
				rows.some(
					(row) =>
						row.binding.sandboxId === target.sandboxId &&
						row.groups.some(
							(group) =>
								group.inputHash === target.inputHash &&
								group.status === "PROJECTED_IMAGES",
						),
				),
		);
		return {
			schemaVersion: 1,
			kind: "worker-session-demand-images",
			authority: summary,
			context,
			store: {
				namespace: readback.namespace,
				observedAtDatabase: readback.observedAtDatabase,
				storeSnapshot: readback.storeSnapshot,
				pageCount: readback.pageCount,
				enumerationComplete: readback.enumerationComplete,
				scope: readback.scope,
				rowCount: readback.items.length,
			},
			targets: targetResults,
			targetScopeStatus: projected
				? "ALL_TARGETS_PROJECTED"
				: "TARGETS_WITH_UNKNOWN",
			rows,
			futureSessionObjectsCreated: receipt.futureSessionObjectsCreated,
			livePodImagesVerified: receipt.livePodImagesVerified,
			sideEffects: receipt.sideEffects,
		};
	} catch {
		throw new Error("WORKER_SESSION_IMAGE_READ_FAILED");
	} finally {
		await Promise.allSettled([reader?.close(), snapshots?.close()]);
	}
}
