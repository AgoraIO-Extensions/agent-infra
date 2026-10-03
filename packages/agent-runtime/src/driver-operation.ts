import { createHash } from "node:crypto";
import {
	RuntimeDriverCommandV1Schema,
	RuntimeDriverOperationRecordV1Schema,
	RuntimeDriverSubmitTurnCommandV2Schema,
	RuntimeDriverSubmitTurnOperationRecordV2Schema,
} from "@agent-infra/contracts/runtime";
import type {
	RuntimeDriverCommand,
	RuntimeDriverOperationRecord,
} from "./driver.js";

export const driverOperationKey = (command: RuntimeDriverCommand) =>
	JSON.stringify([command.kind, command.operationId]);
export const driverRequestDigest = (command: RuntimeDriverCommand) =>
	createHash("sha256")
		.update(
			JSON.stringify(
				(command.schemaVersion === 2
					? RuntimeDriverSubmitTurnCommandV2Schema
					: RuntimeDriverCommandV1Schema
				).parse(command),
			),
		)
		.digest("hex");
export function driverOperationResult(
	command: RuntimeDriverCommand,
	ref: string,
	value: RuntimeDriverOperationRecord["result"],
): RuntimeDriverOperationRecord {
	return (
		command.schemaVersion === 2
			? RuntimeDriverSubmitTurnOperationRecordV2Schema
			: RuntimeDriverOperationRecordV1Schema
	).parse({
		schemaVersion: command.schemaVersion,
		agentId: command.agentId,
		conversationId: command.conversationId,
		sessionGeneration: command.sessionGeneration,
		kind: command.kind,
		operationId: command.operationId,
		nativeSessionRef: ref,
		result: value,
	});
}
