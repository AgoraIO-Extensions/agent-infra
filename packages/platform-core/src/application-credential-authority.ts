import {
	ApplicationApiCredentialErrorV1,
	type ApplicationApiCredentialRequestV1,
	type ApplicationApiCredentialTransactionV1,
	type ApplicationCredentialRecipientV1,
} from "./application-api-credentials.js";
import {
	requirePersonalApiUserActiveV1,
	resolveCurrentPersonalApiUserV1,
} from "./personal-api-credentials.js";
import type { TaskUserDirectoryV1 } from "./task-authorization.js";
export async function authorizeApplicationCredentialDeliveryV1(
	tx: Pick<
		ApplicationApiCredentialTransactionV1,
		"lockUserDisabled" | "lockApplication" | "lockGrant"
	>,
	userDirectory: TaskUserDirectoryV1,
	request: ApplicationApiCredentialRequestV1,
	recipient: ApplicationCredentialRecipientV1,
) {
	if (await tx.lockUserDisabled(request.userId))
		throw new ApplicationApiCredentialErrorV1("forbidden");
	const manager = await resolveCurrentPersonalApiUserV1(
		userDirectory,
		request.userId,
	);
	requirePersonalApiUserActiveV1(manager);
	const application = await tx.lockApplication(request.applicationId);
	if (
		application?.status !== "active" ||
		application.responsibleUserId !== request.userId
	)
		throw new ApplicationApiCredentialErrorV1("not_found");
	if (
		recipient.principalType === "application" &&
		recipient.principalId !== request.applicationId
	)
		throw new ApplicationApiCredentialErrorV1("not_found");
	const grant = await tx.lockGrant(request.applicationId, recipient);
	if (
		!grant ||
		grant.revokedAt !== null ||
		grant.applicationId !== request.applicationId ||
		grant.principalType !== recipient.principalType ||
		grant.principalId !== recipient.principalId
	)
		throw new ApplicationApiCredentialErrorV1("forbidden");
	let recipientRevision: string | null = null;
	if (recipient.principalType === "user") {
		if (await tx.lockUserDisabled(recipient.principalId))
			throw new ApplicationApiCredentialErrorV1("forbidden");
		const user = await resolveCurrentPersonalApiUserV1(
			userDirectory,
			recipient.principalId,
		);
		requirePersonalApiUserActiveV1(user);
		recipientRevision = user.authorizationRevision;
	}
	return { grant, manager, recipientRevision };
}
