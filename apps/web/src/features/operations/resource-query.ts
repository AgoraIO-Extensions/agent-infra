import {
	type OperationsHistoryQueryV2,
	OperationsHistoryV2Schema,
	OperationsLinkV2Schema,
	type OperationsResourceQueryV2,
	OperationsResourcesV2Schema,
	operationsDashboardUrlHeader,
	operationsSessionRequestCoverageHeaderV2,
} from "@agent-infra/contracts/pilot";
import { checkOperationsDashboardAccess } from "../../pilot/generated/sdk.gen.js";
import {
	getOperationsHistoryV2,
	getOperationsResourcesV2,
} from "../../pilot/generated-v2/sdk.gen.js";

export class OperationsQueryError extends Error {
	constructor(readonly kind: "denied" | "not-connected" | "unavailable") {
		super("资源观测查询不可用。");
	}
}
function check(status: number | undefined) {
	if (status === 401 || status === 403)
		throw new OperationsQueryError("denied");
	if (status === 404) throw new OperationsQueryError("not-connected");
	if (status !== 200) throw new OperationsQueryError("unavailable");
}
export async function fetchOperationsDashboardUrl(signal: AbortSignal) {
	const { response } = await checkOperationsDashboardAccess({
		signal,
		throwOnError: false,
	});
	if (response?.status === 401 || response?.status === 403)
		throw new OperationsQueryError("denied");
	if (response?.status !== 204) return null;
	const link = OperationsLinkV2Schema.safeParse({
		kind: "metrics",
		url: response.headers.get(operationsDashboardUrlHeader),
	});
	return link.success ? link.data.url : null;
}

export async function fetchOperationsResources(
	input: OperationsResourceQueryV2,
	signal: AbortSignal,
) {
	const result = await getOperationsResourcesV2({
		query: input,
		headers: { [operationsSessionRequestCoverageHeaderV2]: "1" },
		signal,
		throwOnError: false,
	});
	check(result.response?.status);
	const parsed = OperationsResourcesV2Schema.safeParse(result.data);
	if (!parsed.success) throw new OperationsQueryError("unavailable");
	return parsed.data;
}
export async function fetchOperationsHistory(
	input: OperationsHistoryQueryV2,
	signal: AbortSignal,
) {
	const result = await getOperationsHistoryV2({
		query: input,
		signal,
		throwOnError: false,
	});
	check(result.response?.status);
	const parsed = OperationsHistoryV2Schema.safeParse(result.data);
	if (!parsed.success) throw new OperationsQueryError("unavailable");
	return parsed.data;
}
