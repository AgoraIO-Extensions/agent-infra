import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PlatformApiAssemblyInput } from "./assembly.js";
import { assemblePlatformApi } from "./assembly.js";
import { assembleWecomApiV1 } from "./wecom-assembly.js";

vi.mock("./wecom-assembly.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./wecom-assembly.js")>();
	return { ...actual, assembleWecomApiV1: vi.fn(actual.assembleWecomApiV1) };
});

const publicKey = generateKeyPairSync("rsa", { modulusLength: 3072 })
	.publicKey.export({ type: "spki", format: "pem" })
	.toString();
const databaseUrl = "postgres://invalid:invalid@127.0.0.1:1/invalid";
const unavailable = async (): Promise<never> => {
	throw new Error("Unused adapter");
};
const deployment = {
	identity: { resolveSender: unavailable, activeUsers: unavailable },
	resolveBinding: async () => null,
	replyEncryptionPublicKeyPem: publicKey,
	observe: () => {},
};

describe("WeCom trusted directory assembly", () => {
	it("rejects direct message assembly without a trusted directory before opening resources", () => {
		expect(() => assembleWecomApiV1(databaseUrl, deployment)).toThrow(
			"WeCom message admission requires a trusted user directory",
		);
	});

	it.each([false, true])(
		"wires explicit WeCom deployment with provided directory=%s",
		async (provided) => {
			const current = {
				schemaVersion: 1 as const,
				userId: "trusted-user",
				accountStatus: "active" as const,
				organizationIds: ["trusted-org"],
				authorizationRevision: "current-revision",
			};
			const resolveUser = vi.fn(
				async (): Promise<
					| typeof current
					| ({ accountStatus: "disabled" } & Omit<
							typeof current,
							"accountStatus"
					  >)
				> => current,
			);
			const explicit = { resolveUser: vi.fn(async () => current) };
			const input: PlatformApiAssemblyInput = {
				databaseUrl,
				identity: {
					resolve: unavailable,
					hydrateUsers: unavailable,
					resolveUser,
				},
				taskAdmissionPolicy: {
					maximumWaitingTasksPerAgent: 2,
					waitingTimeoutMs: 60_000,
				},
				admissions: {
					authorizationAdmission: { authorize: unavailable },
					imageAdmission: { admitImage: unavailable },
					modelAdmission: { admitModels: unavailable },
					secretAdmission: { admitSecrets: unavailable },
					channelAdmission: { admitChannels: unavailable },
				},
				allocateApplicationIds: unavailable,
				prepareApplicationSecrets: unavailable,
				prepareConfigurationSecrets: unavailable,
				presentAgent: unavailable,
				wecom: {
					...deployment,
					...(provided ? { userDirectory: explicit } : {}),
				},
			};
			if (!provided) {
				expect(() =>
					assemblePlatformApi({
						...input,
						identity: { resolve: unavailable, hydrateUsers: unavailable },
					}),
				).toThrow("WeCom message admission requires a trusted user directory");
			}
			const assembly = assemblePlatformApi(input);
			try {
				const directory =
					vi.mocked(assembleWecomApiV1).mock.lastCall?.[1].userDirectory;
				expect(await directory?.resolveUser("trusted-user")).toEqual(current);
				expect(
					provided ? explicit.resolveUser : resolveUser,
				).toHaveBeenCalledWith("trusted-user");
				if (provided) expect(resolveUser).not.toHaveBeenCalled();
				else {
					resolveUser.mockResolvedValueOnce({
						...current,
						accountStatus: "disabled",
					});
					expect(await directory?.resolveUser("trusted-user")).toMatchObject({
						accountStatus: "disabled",
					});
					resolveUser.mockRejectedValueOnce(new Error("directory unavailable"));
					await expect(
						directory?.resolveUser("trusted-user"),
					).rejects.toThrow();
				}
			} finally {
				await assembly.close();
			}
		},
	);
});
