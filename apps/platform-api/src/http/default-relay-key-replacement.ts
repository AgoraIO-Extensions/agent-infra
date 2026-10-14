import { HttpProtocolError } from "./common.js";

/** 带默认 Relay Key 的标准 Agent 更换模型集合时，请求里必须一并出现的三项（#2421）。 */
export interface DefaultRelayKeyReplacementV1 {
	readonly defaultRelayKey: string;
	readonly expectedConfigurationRevision: number;
	readonly expectedKeyVersion: number | null;
}

/**
 * 解析请求体里的默认 Key 替换字段：Key、调用方看到的配置修订和 Key 版本要么齐全，
 * 要么全部省略；齐全时必须同时带模型选择，且模型选项不得再携带逐模型凭证。
 * 其余合法性（Key 对哪些模型可见、版本是否过期）由 Core 与 Store 判定。
 */
export function parseDefaultRelayKeyReplacement(
	body: {
		readonly defaultRelayKey?: string | undefined;
		readonly expectedConfigurationRevision?: number | undefined;
		readonly expectedKeyVersion?: number | null | undefined;
		readonly modelConfiguration?:
			| {
					readonly options: readonly {
						readonly credentialValue?: string | undefined;
					}[];
			  }
			| undefined;
	},
	traceId: string,
): DefaultRelayKeyReplacementV1 | undefined {
	const {
		defaultRelayKey,
		expectedConfigurationRevision,
		expectedKeyVersion,
		modelConfiguration,
	} = body;
	if (defaultRelayKey === undefined) {
		if (
			expectedConfigurationRevision !== undefined ||
			expectedKeyVersion !== undefined
		)
			throw new HttpProtocolError("INVALID_REQUEST", traceId);
		return undefined;
	}
	if (
		expectedConfigurationRevision === undefined ||
		expectedKeyVersion === undefined ||
		modelConfiguration === undefined ||
		modelConfiguration.options.some(
			({ credentialValue }) => credentialValue !== undefined,
		)
	)
		throw new HttpProtocolError("INVALID_REQUEST", traceId);
	return { defaultRelayKey, expectedConfigurationRevision, expectedKeyVersion };
}
