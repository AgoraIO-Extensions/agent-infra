import {
	DataLegoV5Adapter,
	datalegoV5ConnectionCatalog,
} from "./datalego-v5.ts";
import { datalegoV6ExecutorDigest } from "./datalego-v6-integrity.ts";

const providerReleaseId = "datalego-connection-v6";
const identifierPattern = "^[A-Za-z_][A-Za-z0-9_]*$";
const tablePattern = "^[A-Za-z_][A-Za-z0-9_]*\\*?$";
const identifierSchema = {
	type: "string",
	minLength: 1,
	maxLength: 128,
	pattern: identifierPattern,
} as const;
const inheritedIds = {
	"datalego.get_current_user@v5": "datalego.get_current_user@v6",
	"datalego.submit_query@v5": "datalego.submit_query@v6",
	"datalego.get_query_status@v5": "datalego.get_query_status@v6",
	"datalego.cancel_query@v5": "datalego.cancel_query@v6",
} as const;

export const datalegoV6ConnectionCatalog = {
	...datalegoV5ConnectionCatalog,
	providerReleaseId,
	executorDigest: datalegoV6ExecutorDigest,
	actions: [
		...datalegoV5ConnectionCatalog.actions.map((action) => ({
			...action,
			id: inheritedIds[action.id],
		})),
		{
			id: "datalego.list_tables@v6",
			name: "datalego.list_tables",
			description:
				"提交 Hive 表名发现任务。database 为库名；pattern 为精确表名或末尾 * 的前缀。返回任务 id，通过 get_query_status 读取表名结果。",
			effect: "WRITE" as const,
			requiredScopes: ["datalego.query"],
			inputSchema: {
				type: "object",
				additionalProperties: false,
				required: ["database", "pattern"],
				properties: {
					database: identifierSchema,
					pattern: { ...identifierSchema, pattern: tablePattern },
				},
			},
		},
		{
			id: "datalego.describe_table@v6",
			name: "datalego.describe_table",
			description:
				"提交 Hive 表结构查询任务。返回任务 id，通过 get_query_status 获取字段名、类型及分区信息；引擎注释可能为空，不能替代 DataLego 目录说明。",
			effect: "WRITE" as const,
			requiredScopes: ["datalego.query"],
			inputSchema: {
				type: "object",
				additionalProperties: false,
				required: ["database", "table"],
				properties: { database: identifierSchema, table: identifierSchema },
			},
		},
	],
} as const;

// The original executor remains immutable; v6 only adds restricted SQL views.
export class DataLegoV6Adapter {
	readonly providerId = datalegoV5ConnectionCatalog.provider;
	readonly providerReleaseId = providerReleaseId;
	private readonly previous: DataLegoV5Adapter;

	constructor(...args: ConstructorParameters<typeof DataLegoV5Adapter>) {
		this.previous = new DataLegoV5Adapter(...args);
	}

	getAuthorizationUrl(
		input: Parameters<DataLegoV5Adapter["getAuthorizationUrl"]>[0],
	) {
		return this.previous.getAuthorizationUrl(input);
	}

	async exchangeCode(input: Parameters<DataLegoV5Adapter["exchangeCode"]>[0]) {
		return {
			...(await this.previous.exchangeCode(input)),
			providerReleaseId,
		};
	}

	async refresh(refreshToken: string) {
		return {
			...(await this.previous.refresh(refreshToken)),
			providerReleaseId,
		};
	}

	async validateCredential(accessToken: string) {
		return {
			...(await this.previous.validateCredential(accessToken)),
			providerReleaseId,
		};
	}

	async execute(input: Parameters<DataLegoV5Adapter["execute"]>[0]) {
		let sql: string;
		if (input.action === "datalego.list_tables") {
			validateKeys(input.input, ["database", "pattern"]);
			const database = identifier(input.input.database, identifierPattern);
			const pattern = identifier(input.input.pattern, tablePattern);
			sql = `SHOW TABLES IN \`${database}\` LIKE '${pattern}'`;
		} else if (input.action === "datalego.describe_table") {
			validateKeys(input.input, ["database", "table"]);
			const database = identifier(input.input.database, identifierPattern);
			const table = identifier(input.input.table, identifierPattern);
			sql = `DESCRIBE \`${database}\`.\`${table}\``;
		} else {
			return this.previous.execute(input);
		}
		return this.previous.execute({
			...input,
			action: "datalego.submit_query",
			input: { engine: "hive", sql, download: false },
		});
	}
}

function validateKeys(input: Record<string, unknown>, allowed: string[]) {
	if (
		!input ||
		Array.isArray(input) ||
		Object.keys(input).some((key) => !allowed.includes(key))
	)
		throw invalidInput("Invalid Hive metadata input");
}

function identifier(value: unknown, pattern: string) {
	if (
		typeof value !== "string" ||
		value.length > 128 ||
		!new RegExp(pattern).test(value)
	)
		throw invalidInput(
			"Hive metadata requires a bounded identifier or table prefix",
		);
	return value;
}

function invalidInput(message: string) {
	return Object.assign(new Error(message), {
		code: "INVALID_REQUEST",
		providerFailure: true,
		providerSubmissionOutcome: "rejected",
		submissionUncertain: false,
	});
}
