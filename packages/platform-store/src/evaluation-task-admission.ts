import {
	type ConversationExecutionAuthorityV1,
	EvaluationDataErrorV1,
	resolveCurrentPersonalApiUserV1,
	type TaskUserDirectoryV1,
} from "@agent-infra/platform-core";
import type postgres from "postgres";
import {
	readCurrentTaskApiUseGrantV1,
	readCurrentTaskApplicationV1,
} from "./application-task-authorization.js";
import {
	type EvaluationCurrentPolicyReaderV1,
	requireCurrentEvaluationTaskV1,
} from "./evaluation-task-authority.js";
export async function requireCurrentEvaluationAdmissionV1(
	tx: postgres.TransactionSql,
	authority: ConversationExecutionAuthorityV1,
	directory: TaskUserDirectoryV1 | undefined,
	loadPolicy: EvaluationCurrentPolicyReaderV1 | undefined,
) {
	const boundary = authority.taskBoundary;
	if (
		!boundary ||
		!loadPolicy ||
		boundary.channelId !== "eval" ||
		boundary.principal.id !== authority.actorId ||
		boundary.accessSources.length !== 1 ||
		boundary.accessSources[0]?.kind !== "eval-use"
	)
		throw new EvaluationDataErrorV1("denied");
	await tx`lock table platform.platform_user_disables in share mode`;
	const grant = await readCurrentTaskApiUseGrantV1(tx, {
		principal: boundary.principal,
		agentId: boundary.agentId,
	});
	if (
		!grant ||
		grant.revoked ||
		grant.authorizationRevision !== boundary.accessSources[0].useGrantRevision
	)
		throw new EvaluationDataErrorV1("denied");
	if (boundary.principal.kind === "user") {
		const user = await resolveCurrentPersonalApiUserV1(
			directory,
			boundary.principal.id,
		);
		const disabled =
			await tx`select user_id from platform.platform_user_disables where user_id=${boundary.principal.id}`;
		if (
			!user ||
			disabled.length ||
			user.accountStatus !== "active" ||
			user.authorizationRevision !== boundary.identityRevision
		)
			throw new EvaluationDataErrorV1("denied");
	} else {
		const application = await readCurrentTaskApplicationV1(tx, {
			applicationId: boundary.principal.id,
			agentId: boundary.agentId,
		});
		if (
			!application ||
			application.status !== "active" ||
			application.authorizationRevision !== boundary.identityRevision
		)
			throw new EvaluationDataErrorV1("denied");
	}
	return requireCurrentEvaluationTaskV1(tx, boundary, loadPolicy);
}
