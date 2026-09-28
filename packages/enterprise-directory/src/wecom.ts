import { z } from "zod";
import type { DirectoryDepartment, DirectoryMember } from "./snapshot.js";

const responseBase = z.object({ errcode: z.number().int() });
const tokenResponse = responseBase.extend({ access_token: z.string().min(1) });
const departmentsResponse = responseBase.extend({
	department: z.array(
		z.object({
			id: z.number().int().positive(),
			name: z.string().min(1),
			parentid: z.number().int().nonnegative(),
		}),
	),
});
const usersResponse = responseBase.extend({
	userlist: z.array(
		z.object({
			userid: z.string().min(1),
			email: z.string().default(""),
			status: z.number().int(),
			department: z.array(z.number().int().positive()).min(1),
		}),
	),
});

export interface WeComSourceConfig {
	corpId: string;
	corpSecret: string;
	rootDepartmentId: number;
	fetch?: typeof fetch;
}

export class WeComSourceError extends Error {
	constructor() {
		super("Enterprise directory source is unavailable or incomplete");
	}
}

export function createWeComSource(config: WeComSourceConfig) {
	const fetcher = config.fetch ?? fetch;
	if (
		!Number.isSafeInteger(config.rootDepartmentId) ||
		config.rootDepartmentId < 1
	) {
		throw new WeComSourceError();
	}
	async function get<T>(
		path: string,
		params: Record<string, string>,
		schema: z.ZodType<T>,
	): Promise<T> {
		const url = new URL(path, "https://qyapi.weixin.qq.com");
		for (const [key, value] of Object.entries(params))
			url.searchParams.set(key, value);
		let response: Response;
		try {
			response = await fetcher(url, {
				redirect: "error",
				signal: AbortSignal.timeout(10_000),
			});
			if (!response.ok) throw new WeComSourceError();
			const parsed = schema.parse(await response.json());
			if (responseBase.parse(parsed).errcode !== 0)
				throw new WeComSourceError();
			return parsed;
		} catch {
			throw new WeComSourceError();
		}
	}
	return {
		async fetchComplete(): Promise<{
			departments: DirectoryDepartment[];
			members: DirectoryMember[];
		}> {
			const token = await get(
				"/cgi-bin/gettoken",
				{ corpid: config.corpId, corpsecret: config.corpSecret },
				tokenResponse,
			);
			const accessToken = token.access_token;
			const departmentsResult = await get(
				"/cgi-bin/department/list",
				{
					access_token: accessToken,
					id: String(config.rootDepartmentId),
				},
				departmentsResponse,
			);
			const departments = departmentsResult.department.map(
				({ id, name, parentid }) => ({
					id,
					name,
					parentId: id === config.rootDepartmentId ? 0 : parentid,
				}),
			);
			const membersById = new Map<string, DirectoryMember>();
			for (const department of departments) {
				const users = await get(
					"/cgi-bin/user/list",
					{
						access_token: accessToken,
						department_id: String(department.id),
						fetch_child: "0",
						status: "0",
					},
					usersResponse,
				);
				for (const user of users.userlist) {
					const member = {
						userId: user.userid,
						email: user.email,
						active: user.status === 1,
						departmentIds: user.department.toSorted((a, b) => a - b),
					};
					const previous = membersById.get(member.userId);
					if (previous && JSON.stringify(previous) !== JSON.stringify(member)) {
						throw new WeComSourceError();
					}
					membersById.set(member.userId, member);
				}
			}
			return { departments, members: [...membersById.values()] };
		},
	};
}
