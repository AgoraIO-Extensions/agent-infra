import {
	createSkillProjectSourceVerifierV1,
	type ObjectStorageDataV1,
	packSkillProjectSnapshotV1,
	readAdmittedSkillPackageEntryV1,
	SkillPackageAdmissionErrorV1,
	type SkillPackageAdmissionPolicyV1,
	type SkillPackageScannerV1,
	type SkillPackageSourceVerifierV1,
	SkillPackageSupplierV1,
} from "@agent-infra/object-storage";
import type { SkillProviderRegistryV1 } from "@agent-infra/platform-core";
import {
	createSkillHubProjectPublicationV1,
	createSkillProviderImportV1,
	pageSkillHubInstallationsV1,
	pageSkillHubOwnedVersionsV1,
	pageSkillHubReviewQueueV1,
	pageSkillHubVersionsV1,
	projectSkillHubProjectContentV1,
	projectSkillHubVersionContentV1,
	projectSkillHubVersionDetailV1,
	projectSkillHubVersionMetadataV1,
	SkillHubOperationErrorV1,
	type SkillHubRequestV1,
	type SkillHubVersionContentV1,
} from "@agent-infra/platform-core";
import { PostgresSkillHubLifecycleV1 } from "@agent-infra/platform-store";
import { createDeploymentIdentityScope } from "./deployment-identity.js";
import type { IdentityAdapter } from "./http/identity.js";
import type { SkillHubImportRoutesDependenciesV1 } from "./http/skill-hub-import-routes.js";
import type { SkillHubInstallationListRoutesDependenciesV1 } from "./http/skill-hub-installation-list-routes.js";
import type { SkillHubInstallationRoutesDependenciesV1 } from "./http/skill-hub-installation-routes.js";
import type { SkillHubProjectContentRoutesDependenciesV1 } from "./http/skill-hub-project-content-routes.js";
import type { SkillHubProjectRoutesDependenciesV1 } from "./http/skill-hub-project-routes.js";
import type { SkillHubPublicationRoutesDependenciesV1 } from "./http/skill-hub-publication-routes.js";
import type { SkillHubReadRoutesDependenciesV1 } from "./http/skill-hub-read-routes.js";
import type { SkillHubReviewRoutesDependenciesV1 } from "./http/skill-hub-review-routes.js";
import type { SkillHubVersionDetailRoutesDependenciesV1 } from "./http/skill-hub-version-detail-routes.js";

export type SkillHubProviderImportDeploymentV1 = Readonly<{
	readonly registry: SkillProviderRegistryV1;
	readonly storage: ObjectStorageDataV1;
	readonly resolveAdmissionPolicy: () => Promise<SkillPackageAdmissionPolicyV1>;
	readonly sourceVerifier: SkillPackageSourceVerifierV1;
	readonly scanner: SkillPackageScannerV1;
}>;

export function assembleSkillHubReadApiV1(input: {
	readonly databaseUrl: string;
	readonly identity: IdentityAdapter;
	readonly providerImport?: SkillHubProviderImportDeploymentV1;
}) {
	const scope = createDeploymentIdentityScope(input.identity);
	const store = new PostgresSkillHubLifecycleV1({
		databaseUrl: input.databaseUrl,
		async resolveIdentity(userId) {
			// Resolve the original authenticated request at both transaction fences.
			const identity = await scope.currentIdentity("skill-hub-read");
			if (identity.userId !== userId)
				throw new SkillHubOperationErrorV1("forbidden");
			return {
				actor: {
					schemaVersion: 1,
					userId: identity.userId,
					accountStatus: identity.accountStatus,
					organizationIds: identity.organizationIds,
					isAdministrator: identity.roles.includes("system_admin"),
				},
				authorizationRevision: identity.authorizationRevision,
			};
		},
	});
	const providerImport = input.providerImport
		? new SkillPackageSupplierV1({
				storage: input.providerImport.storage,
				lifecycle: store,
				resolveAdmissionPolicy: input.providerImport.resolveAdmissionPolicy,
				sourceVerifier: input.providerImport.sourceVerifier,
				scanner: input.providerImport.scanner,
			})
		: undefined;
	const dependencies: SkillHubReadRoutesDependenciesV1 = {
		identity: input.identity,
		list: (request, trusted, query) =>
			scope.requestScope(request, async () =>
				pageSkillHubVersionsV1(await store.listVisibleVersions(trusted), query),
			),
		read: (request, trusted, versionId) =>
			scope.requestScope(request, async () =>
				projectSkillHubVersionMetadataV1(
					await store.readVisibleVersion(trusted, versionId),
				),
			),
		recordRefusal: (metadata, userId, reason) =>
			store.recordReadRefusal(metadata, userId, reason),
	};
	const projectDependencies: SkillHubProjectRoutesDependenciesV1 = {
		identity: input.identity,
		list: (request, trusted) =>
			scope.requestScope(request, async () => store.listProjects(trusted)),
		read: (request, trusted, projectId) =>
			scope.requestScope(request, async () =>
				store.readProject(trusted, projectId),
			),
		create: (request, trusted, key, inputValue) =>
			scope.requestScope(request, async () =>
				store.createProject(trusted, key, inputValue),
			),
		update: (request, trusted, projectId, key, inputValue) =>
			scope.requestScope(request, async () =>
				store.updateProject(trusted, projectId, key, inputValue),
			),
	};
	const installationDependencies: SkillHubInstallationRoutesDependenciesV1 = {
		identity: input.identity,
		install: (request, trusted, key, command) =>
			scope.requestScope(request, async () =>
				store.installVersion(trusted, key, command),
			),
		uninstall: (request, trusted, installationId, key) =>
			scope.requestScope(request, async () =>
				store.uninstallInstallation(trusted, installationId, key),
			),
	};
	const installationListDependencies: SkillHubInstallationListRoutesDependenciesV1 =
		{
			identity: input.identity,
			list: (request, trusted, query) =>
				scope.requestScope(request, async () =>
					pageSkillHubInstallationsV1(
						await store.listInstallations(trusted, query),
						trusted.userId,
					),
				),
			recordRefusal: (metadata, userId, reason) =>
				store.recordReadRefusal(metadata, userId, reason),
		};
	const publicationDependencies: SkillHubPublicationRoutesDependenciesV1 = {
		identity: input.identity,
		publish: (request, trusted, key, command) =>
			scope.requestScope(request, async () =>
				store.registerVersion(trusted, key, command),
			),
		review: (request, trusted, versionId, key, command) =>
			scope.requestScope(request, async () =>
				store.reviewVersion(trusted, versionId, key, command),
			),
		revoke: (request, trusted, versionId, key) =>
			scope.requestScope(request, async () =>
				store.revokeVersion(trusted, versionId, key),
			),
	};
	const reviewDependencies: SkillHubReviewRoutesDependenciesV1 = {
		identity: input.identity,
		list: (request, trusted, query) =>
			scope.requestScope(request, async () =>
				pageSkillHubReviewQueueV1(
					await store.listPendingReviewVersions(trusted, query),
				),
			),
		recordRefusal: (metadata, userId, reason) =>
			store.recordReadRefusal(metadata, userId, reason),
	};
	// 详情正文只从部署维护的 Skill 包存储按固定对象版本读取；未装配、无包描述或核对失败时
	// 内容标记不可用，版本、发布者与安装状态照常返回。
	const packageStorage = input.providerImport?.storage;
	const versionDetailDependencies: SkillHubVersionDetailRoutesDependenciesV1 = {
		identity: input.identity,
		listOwned: (request, trusted, query) =>
			scope.requestScope(request, async () =>
				pageSkillHubOwnedVersionsV1(
					await store.listOwnedVersions(trusted, query),
					trusted.userId,
				),
			),
		readDetail: (request, trusted, versionId) =>
			scope.requestScope(request, async () => {
				const detail = await store.readVersionDetail(trusted, versionId);
				let content: SkillHubVersionContentV1 = { state: "unavailable" };
				if (packageStorage && detail.packageObject)
					try {
						content = projectSkillHubVersionContentV1(
							await readAdmittedSkillPackageEntryV1({
								storage: packageStorage,
								zip: detail.packageObject,
								name: detail.version.name,
								version: detail.version.version,
								packageDigest: detail.version.packageDigest,
								manifestDigest: detail.version.manifestDigest,
								signal: request.signal,
							}),
						);
					} catch {
						/* 内容读取或核对失败不暴露原因，只标记不可用。 */
					}
				return projectSkillHubVersionDetailV1({ ...detail, content });
			}),
		recordRefusal: (metadata, userId, reason) =>
			store.recordReadRefusal(metadata, userId, reason),
	};
	const importDependencies: SkillHubImportRoutesDependenciesV1 | undefined =
		providerImport && input.providerImport
			? {
					identity: input.identity,
					requestScope: scope.requestScope,
					importer: createSkillProviderImportV1({
						registry: input.providerImport.registry,
						admit: async ({ context, key, selection, candidate }) => {
							const policy =
								await input.providerImport?.resolveAdmissionPolicy();
							if (!policy) throw new SkillHubOperationErrorV1("unavailable");
							return providerImport.admitVersion(
								context,
								{
									...selection,
									sourceVersion: candidate.sourceVersion,
									sourceDigest: candidate.sourceDigest,
									approvalRef: candidate.approvalRef,
									trustRevision: policy.signer.trustRevision,
									policyRevision: policy.policyRevision,
									archiveBytes: candidate.archiveBytes,
								},
								key,
							);
						},
					}),
				}
			: undefined;
	// 网页项目发布（#2906）：复用部署的 Skill 包存储、扫描器与 admission policy（同一 signer），
	// 来源证明由平台项目供应生成，不调用部署的外部来源校验器。
	const projectSupplier = input.providerImport
		? new SkillPackageSupplierV1({
				storage: input.providerImport.storage,
				lifecycle: store,
				resolveAdmissionPolicy: input.providerImport.resolveAdmissionPolicy,
				sourceVerifier: createSkillProjectSourceVerifierV1(),
				scanner: input.providerImport.scanner,
			})
		: undefined;
	const projectPublication =
		projectSupplier && input.providerImport
			? createSkillHubProjectPublicationV1({
					readSource: (context, projectId, check) =>
						store.readProjectPublicationSource(context, projectId, check),
					pack: (files) =>
						packSkillProjectSnapshotV1(
							files.map((file) => ({ path: file.path, bytes: file.bytes })),
						),
					admit: async ({ context, key, selection, source, archiveBytes }) => {
						const policy = await input.providerImport?.resolveAdmissionPolicy();
						if (!policy) throw new SkillHubOperationErrorV1("unavailable");
						try {
							return await projectSupplier.admitVersion(
								context,
								{
									...selection,
									...source,
									trustRevision: policy.signer.trustRevision,
									policyRevision: policy.policyRevision,
									archiveBytes,
								},
								key,
							);
						} catch (error) {
							throw projectAdmissionFailure(error);
						}
					},
				})
			: undefined;
	const projectContentDependencies: SkillHubProjectContentRoutesDependenciesV1 =
		{
			identity: input.identity,
			read: (request, trusted, projectId) =>
				scope.requestScope(request, async () => {
					const source = await store.readProjectContent(trusted, projectId);
					return projectSkillHubProjectContentV1({
						projectId: source.project.projectId,
						revision: source.revision,
						updatedAt: source.updatedAt,
						content: source.content,
					});
				}),
			save: (request, trusted, projectId, key, value) =>
				scope.requestScope(request, async () =>
					store.saveProjectContent(trusted, projectId, key, value),
				),
			...(projectPublication
				? {
						publish: (
							request: Request,
							trusted: SkillHubRequestV1,
							projectId: string,
							key: string,
							value: unknown,
						) =>
							scope.requestScope(request, () =>
								projectPublication.publish(trusted, projectId, key, value),
							),
					}
				: {}),
			recordRefusal: (metadata, userId, reason) =>
				store.recordReadRefusal(metadata, userId, reason),
		};
	return {
		dependencies,
		installationDependencies,
		installationListDependencies,
		publicationDependencies,
		reviewDependencies,
		versionDetailDependencies,
		importDependencies,
		projectDependencies,
		projectContentDependencies,
		close: () => store.close(),
	};
}

/**
 * 网页发布的包准入失败：内容格式、上限或扫描拒绝属于调用方可修改的内容问题；
 * 来源、签名、摘要或依赖失败属于平台侧，按不可用返回，不暴露内部原因。
 */
function projectAdmissionFailure(error: unknown) {
	if (!(error instanceof SkillPackageAdmissionErrorV1)) return error;
	return new SkillHubOperationErrorV1(
		[
			"invalid_archive",
			"archive_limit",
			"invalid_path",
			"duplicate_path",
			"path_conflict",
			"symlink",
			"missing_entry",
			"scan_rejected",
		].includes(error.code)
			? "invalid_input"
			: "unavailable",
	);
}
