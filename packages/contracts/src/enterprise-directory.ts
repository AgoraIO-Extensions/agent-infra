import { z } from "zod";

export const DirectorySourceIdSchema = z
	.string()
	.regex(/^[a-z][a-z0-9-]{0,63}$/u);

export const DirectorySnapshotBindingV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	source: DirectorySourceIdSchema,
	revision: z.uuid(),
	fetchedAt: z.number().int().nonnegative(),
	validUntil: z.number().int().positive(),
});

export const EnterpriseDirectorySnapshotV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	revision: z.uuid(),
	source: z.literal("wecom"),
	rootDepartmentId: z.number().int().positive(),
	fetchedAt: z.number().int().nonnegative(),
	validUntil: z.number().int().positive(),
	complete: z.literal(true),
	departments: z
		.array(
			z.strictObject({
				id: z.number().int().positive(),
				name: z.string().min(1).regex(/\S/u),
				parentId: z.number().int().nonnegative(),
			}),
		)
		.min(1),
	members: z.array(
		z.strictObject({
			userId: z.string().min(1).regex(/\S/u),
			email: z.string(),
			active: z.boolean(),
			departmentIds: z.array(z.number().int().positive()).min(1),
		}),
	),
});

export const enterpriseDirectoryOpenApiPathsV1 = {
	"/internal/directory/snapshot": {
		get: {
			operationId: "readEnterpriseDirectorySnapshotV1",
			summary: "Read the current complete WeCom directory snapshot",
			responses: {
				200: {
					description: "Current complete snapshot",
					content: {
						"application/json": { schema: EnterpriseDirectorySnapshotV1Schema },
					},
				},
				401: {
					description: "Service authentication failed",
					content: {
						"application/json": {
							schema: z.strictObject({ error: z.literal("unauthorized") }),
						},
					},
				},
				503: {
					description: "No current complete snapshot is available",
					content: {
						"application/json": {
							schema: z.strictObject({
								error: z.literal("directory_unavailable"),
							}),
						},
					},
				},
			},
		},
	},
};

export const EnterpriseDirectorySnapshotV2Schema =
	EnterpriseDirectorySnapshotV1Schema.extend({
		schemaVersion: z.literal(2),
		source: DirectorySourceIdSchema,
	});
const legacyRead =
	enterpriseDirectoryOpenApiPathsV1["/internal/directory/snapshot"].get;
export const enterpriseDirectoryOpenApiPathsV2 = {
	"/internal/directory/v2/snapshot": {
		get: {
			...legacyRead,
			operationId: "readEnterpriseDirectorySnapshotV2",
			summary: "Read the current complete enterprise directory snapshot",
			responses: {
				...legacyRead.responses,
				200: {
					...legacyRead.responses[200],
					content: {
						"application/json": { schema: EnterpriseDirectorySnapshotV2Schema },
					},
				},
			},
		},
	},
};
