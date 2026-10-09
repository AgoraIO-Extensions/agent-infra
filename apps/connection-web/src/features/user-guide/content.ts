// One content source for the Connection page and exported Markdown manual.
export type GuideSection = {
	title: string;
	paragraphs: string[];
	steps?: string[];
	code?: string;
	language?: string;
};
export type GuideChapter = {
	id: string;
	title: string;
	summary: string;
	sections: GuideSection[];
};
export const guideChapters: GuideChapter[] = [
	{
		id: "01",
		title: "从这里开始",
		summary: "登录、连接外部账号、确认客户端授权，是三个独立步骤。",
		sections: [
			{
				title: "Connection 是什么",
				paragraphs: [
					"Connection 负责外部账号、Provider Credential、Consumer 授权和外部 Action 调用。Codex、其他 MCP Client、Agent Platform 和内部服务都可以使用它；使用 Direct MCP 不需要先创建平台 Agent。",
					"Provider 是外部服务，Action 是一项受控能力，Connection 是已连接的具体外部账号，Consumer 是使用能力的客户端或服务。公司登录、Provider 连接、Consumer 授权分别完成，任何一步成功都不等于其他步骤已完成。",
				],
			},
			{
				title: "完成第一次只读调用",
				paragraphs: [],
				steps: [
					"打开团队提供的 Connection HTTPS 地址，登录控制台并确认公司身份。",
					"在“我的 Connection”选择目标服务，检查是否需要先申请接入资格。",
					"完成必要审批后，连接自己的外部账号并核对返回的账号名称。",
					"选择客户端 Consumer 与当前账号，勾选所需 Action，阅读预览后确认授权。",
					"按对应客户端的安装说明配置 Connection MCP，完成 OAuth 登录或引用获准 PAT。",
					"在客户端重新发现能力，先用已授权的只读 Action 核对账号和实际结果。",
				],
			},
			{
				title: "完成标志",
				paragraphs: [
					"控制台账号连接有效，目标 Consumer 已获得明确的 Action 授权，客户端返回真实只读结果。模型自报“连接成功”、目录出现服务名或浏览器登录成功都不能替代这三个条件。",
				],
			},
		],
	},
	{
		id: "02",
		title: "控制台与登录",
		summary: "公司身份用于 Connection Account，外部服务凭证另行管理。",
		sections: [
			{
				title: "登录与退出",
				paragraphs: [
					"访问 /connection/login，使用部署提供的公司 LDAP 登录。密码只用于当次认证，不保存、不进入 MCP 配置或模型上下文。退出浏览器管理会话与撤销客户端实例是不同操作；需要终止客户端调用时，还要撤销相应实例、PAT 或授权。",
				],
			},
			{
				title: "找到自己的入口",
				paragraphs: [
					"“我的 Connection”管理账号与 Consumer 授权；“待我审批”处理分配给你的审批任务；“访问令牌”签发和撤销 PAT。通知与待办汇总待审批、续期和升级事项，不把通知已读当作审批完成。",
					"管理员另有审批管理、操作记录、Agent 接入、共享 Connection 和管理员入口。角色只授予管理职责，不自动赋予共享账号使用资格、审批通过权或他人的调用内容权限。",
				],
			},
		],
	},
	{
		id: "03",
		title: "服务目录与外部账号",
		summary: "按当前发布的 Provider、认证方式与能力选择服务。",
		sections: [
			{
				title: "选择正确服务",
				paragraphs: [
					"目录由 Connection 发布，具体可用 Provider、版本、Action 和认证入口以当前控制台为准。同品牌的不同 Jenkins 等部署可能是独立 Provider，必须核对目标环境，不按名称猜测 endpoint。",
					"Connection 提供多服务接入，支持范围以当前发布目录为准，不按单一示例服务推断其他能力。目录展示不代表所有 Action、账号或客户端已完成真实验收。",
				],
			},
			{
				title: "连接自己的账号",
				paragraphs: [],
				steps: [
					"进入“我的 Connection”，选定服务及能力范围。",
					"若显示申请或资格不足，先按下一章完成接入审批，不先提交外部 Credential。",
					"使用页面实际提供的 OAuth、PAT/API Key 或账号密码表单。",
					"OAuth 时核对目标服务和授权范围；手工凭证只填专用表单，不粘贴到聊天或 MCP 工具参数。",
					"回到控制台检查外部账号标识、连接状态及能力范围，再授权 Consumer。",
				],
			},
			{
				title: "认证方式的区别",
				paragraphs: [
					"GitHub 等 OAuth 服务通过提供方页面完成连接；Bitbucket 等可使用 Provider PAT；Jira/Confluence 的 Provider 账号凭证与公司 LDAP 登录分别处理。以该服务当前表单和说明为准，不能在不同 Provider 间复用另一套鉴权配置。",
					"Provider PAT 属于外部服务 Credential，Connection PAT 属于客户端访问令牌，两者不可互换。凭证验证成功仍不自动授权任何 Consumer。",
				],
			},
		],
	},
	{
		id: "04",
		title: "前置接入审批与续期",
		summary: "公司准入资格、Provider 鉴权和 Consumer 授权互不替代。",
		sections: [
			{
				title: "申请前查看范围",
				paragraphs: [
					"管理员为 Provider 能力配置审批策略、能力包、顺序阶段、通过人数、有效期和免责声明。用户选择当前发布的能力范围并阅读说明；能力包修订不会将旧版批准自动扩张到新版本。",
				],
			},
			{
				title: "从申请到连接",
				paragraphs: [],
				steps: [
					"在服务的接入入口选择能力包并提交申请。",
					"在申请详情查看每个阶段的状态；审批人从“待我审批”处理任务。",
					"等待全部必要阶段通过，再进入允许的连接入口。",
					"完成 Provider 鉴权并连接指定账号；连接许可只能成功创建一个外部账号 Connection。",
					"另行选择 Consumer 和 Action 并确认授权。",
				],
			},
			{
				title: "资格到期与重新审批",
				paragraphs: [
					"有限期资格按页面提示在允许的续期窗口申请。续期待审期间原期限照常生效，过期后新调用停止；审批提前通过不损失原剩余时间。换号、能力范围变化、资格失效等按当前策略重新处理。",
					"管理员身份不自动产生审批通过权；员工不能自行审批自己的接入申请。审批通过不是外部账号身份验证，也不会建立 Consumer Grant。",
				],
			},
		],
	},
	{
		id: "05",
		title: "Consumer 与 Action 授权",
		summary: "明确选择谁可以使用哪个账号，以及允许执行哪些操作。",
		sections: [
			{
				title: "确认授权",
				paragraphs: [],
				steps: [
					"在 Connection 卡片进入授权操作，选定目标 Consumer；Delegated Consumer 要求 Actor 时选择已注册的实际 Actor。",
					"核对 Provider、外部账号、Connection、Action 版本、参数说明、scope 和外部效果。",
					"只勾选本次需要的能力，检查搜索或筛选后的选中范围。",
					"获取并阅读授权预览；信息或权限范围变化时重新预览。",
					"明确确认后保存，再让客户端重新发现可用能力。",
				],
			},
			{
				title: "授权的边界",
				paragraphs: [
					"Consumer 管理者声明产品需要的 Action，但不能替你选择账号或扩大授权。Direct Consumer 不使用 Actor；需要 Actor 的 Delegated Consumer 必须携带获准的稳定 Actor，不能缺省回退。",
					"客户端只看到当前授权允许的能力。新增 Action、scope 或 effect 扩张必须重新确认；取消确认不会扩权。停用、撤回或权限收缩立即影响新调用。调整 Action 子集通常不需要重新签发客户端 PAT。",
				],
			},
		],
	},
	{
		id: "06",
		title: "个人、共享与多个账号",
		summary: "每个客户端只使用你为它明确选择的当前账号。",
		sections: [
			{
				title: "个人与共享 Connection",
				paragraphs: [
					"个人 Connection 属于当前员工。公司共享 Connection 由管理员配置共享账号及使用资格；进入共享范围不等于已授权 Consumer，符合资格的员工仍需独立确认。",
					"普通管理员身份不自动获得共享账号使用资格，Owner 或其他用户的个人账号不能作为你的默认后备身份。",
				],
			},
			{
				title: "同一服务的多个账号",
				paragraphs: [
					"可以同时保存个人与公司等多个外部账号。一个 Consumer/Actor 在同一 Provider 下只使用已确认的当前 Connection，不存在调用方指定账号或自动轮询账号的规则。",
					"切换前核对账号、范围和将受影响的 Consumer；切换必须由本人明确确认，不能因鉴权失败静默使用另一账号。断开某个账号前检查它关联的客户端授权。",
				],
			},
		],
	},
	{
		id: "07",
		title: "安装到 Codex",
		summary: "Codex 专用安装说明保持独立。",
		sections: [
			{
				title: "使用专用入口",
				paragraphs: [
					"打开 /connection/，按该页面及根 /llms.txt 的 Codex 专用说明安装。不要把通用 Agent SDK 接入说明混入 Codex 的机器安装指令。",
				],
			},
			{
				title: "OAuth 配置示例",
				paragraphs: [
					"以部署公布的真实 HTTPS 地址替换下面示例域名；配置本地 Codex 的 Connection MCP server 后启动 OAuth 登录。公司密码只提交到 Connection 浏览器入口，不进入 Codex 配置。",
				],
				code: '[mcp_servers.connection]\nurl = "https://connection.example.com/mcp"',
				language: "toml",
			},
			{
				title: "登录并核验",
				paragraphs: [
					"运行 codex mcp login connection，完成浏览器登录及授权。回到 Codex 后读取当前可用能力并先执行无副作用的账号查询；缺少服务或权限时回到控制台处理，而不是传入自报身份字段。",
				],
				code: "codex mcp login connection",
				language: "bash",
			},
			{
				title: "兼容性",
				paragraphs: [
					"只使用部署批准并验证的客户端版本。OAuth 刷新、重放拒绝、撤销和多设备行为必须按实际版本验证；某一客户端通过不代表其他产品已兼容。",
				],
			},
		],
	},
	{
		id: "08",
		title: "跨设备与登录实例",
		summary: "同一账号共享已连接的 Provider 和同一 Consumer 的授权。",
		sections: [
			{
				title: "第二台设备",
				paragraphs: [
					"在第二台设备配置相同 Connection endpoint，并通过其独立 OAuth 登录实例认证为同一员工。已存在的个人 Connection 和该 Direct Consumer 的 Grant 可以复用，不重复做 Provider OAuth或逐设备重新确认。",
					"每台安装仍有独立 ConsumerInstance，不共享 session 或 refresh token。设备退出或实例撤销只终止该实例，不取消其他活跃实例使用已有 Grant 的资格。",
				],
			},
			{
				title: "产品与实例不要混淆",
				paragraphs: [
					"Codex、Claude App、Cursor 等产品是独立 Consumer，不能把一个产品的 OAuth 会话导入另一个产品。换设备共享账号并不自动授权另一个 Consumer；在新产品下仍须明确确认它的能力。",
				],
			},
		],
	},
	{
		id: "09",
		title: "Connection PAT",
		summary: "一次性展示的客户端令牌，与 Provider 凭证不同。",
		sections: [
			{
				title: "签发与保存",
				paragraphs: [],
				steps: [
					"先登录 Connection 控制台，进入“访问令牌”。",
					"按当前页面提供的获准 Consumer 与有效期选项，为令牌取能识别用途的名称。",
					"签发后立即保存到客户端受控环境变量或 Secret Manager，明文只展示一次。",
					"为该 PAT 的 Consumer 配置实际账号和 Action 授权。",
					"先做只读验证，不再使用时在访问令牌页面撤销。",
				],
			},
			{
				title: "通用与具名 PAT",
				paragraphs: [
					"通用 PAT 使用内建 Portable PAT Consumer；获准的具名 MCP Consumer 可以通过固定回调和单次领取流程绑定自己的 PAT。调用方自报产品名称或 Consumer ID 不会改变身份。",
					"同一枚 PAT 可以部署到多个消费端，但它们共享同一个撤销和审计边界；需要逐端独立撤销或追溯时分别签发命名 PAT。PAT 不包含外部账号原始 Credential。",
				],
			},
			{
				title: "配置示例",
				paragraphs: [
					"只引用环境变量，不将明文写入版本库、聊天、日志或 URL。下面域名需替换为实际部署地址。",
				],
				code: '[mcp_servers.connection]\nurl = "https://connection.example.com/mcp"\nbearer_token_env_var = "CONNECTION_TOKEN"',
				language: "toml",
			},
		],
	},
	{
		id: "10",
		title: "通用 Agent 与五个 MCP 工具",
		summary: "Agent 的 MCP 接入和多用户平台的 Delegated 接入分别处理。",
		sections: [
			{
				title: "通用 Agent",
				paragraphs: [
					"打开 /connection/agent/ 及其独立 llms.txt。使用支持 Streamable HTTP 的 MCP 客户端连接 /mcp；支持 remote OAuth 时按 PKCE 登录，否则引用用户签发的获准 Connection PAT。",
					"MCP 客户端初始化后使用 tools/list 读取实际工具 Schema，不猜 Action ID，不传入 Provider Credential 或 Principal/Consumer/账号选择器。",
				],
			},
			{
				title: "发现到执行",
				paragraphs: [],
				steps: [
					"list_apps：发现当前可用 Provider。",
					"list_connections：核对当前可用账号及安全信息。",
					"search_actions：搜索本次需要的 Action。",
					"get_action_guide：阅读参数、结果、scope、effect 和幂等要求。",
					"execute_action：使用实际 Schema 和 guide 执行，检查返回结果。",
				],
			},
			{
				title: "多用户服务与 Delegated",
				paragraphs: [
					"Portable PAT 的 MCP 调用属于 Direct。代表当前用户调用的多用户平台须与管理员完成 Delegated HTTP/OpenAPI 接入，包括受信 workload 身份、短期委托上下文及必要 Actor。",
					"Agent Platform 要求稳定 Agent Actor，不能用共享 PAT、Owner 身份、自报用户 ID 或 MCP URL 拼出 Delegated 身份和接口。委托上下文只证明请求主体，不自动建立或扩张授权。",
				],
			},
		],
	},
	{
		id: "11",
		title: "升级、重连与凭证轮换",
		summary: "保留已有选择，明确确认变化。",
		sections: [
			{
				title: "Provider 升级",
				paragraphs: [
					"查看控制台升级任务中的版本、兼容性、认证变化和 Action 差异。能证明相同账号与相同 scope 的已保存 Credential 可以复用；不要仅因版本更新就重新输入只展示一次的 Token。",
					"原 Action 选择应保留在有明确兼容性证明的范围内；新增或扩大能力必须由本人确认。Token 失效、认证方式或 scope 变化、换号和主动轮换时，按任务提示重新鉴权。",
				],
			},
			{
				title: "重连与换号",
				paragraphs: [
					"重连时核对外部稳定账号标识。连接到不同外部账号不是原账号的透明重连，不能将旧 Grant 静默带给新账号。换号前检查受影响的 Consumer 并重新确认。",
					"Credential refresh/rotation 和 Consumer 访问 token 是不同生命周期。客户端失去 OAuth 登录资格不一定需要重新连接 Provider；先按错误说明检查实例、授权与账号。",
				],
			},
		],
	},
	{
		id: "12",
		title: "写操作、结果未知与撤销",
		summary: "写入前确认效果，超时后先核实原调用。",
		sections: [
			{
				title: "执行写操作",
				paragraphs: [
					"先确认目标账号、仓库或对象、参数、Action 版本与外部效果。用户要求“分析”不等于允许发布、删除或合并。写 Action 必须由客户端生成并保留跨重试稳定的 idempotencyKey，不能使用每次变化的传输请求 ID。未通过稳定幂等键验收的客户端版本只能调用只读 Action。同一业务操作重试不换新的幂等键。",
				],
			},
			{
				title: "结果未知",
				paragraphs: [],
				steps: [
					"看到 UNCERTAIN、超时或断连时保留原调用编号和幂等信息。",
					"回读原调用状态并检查目标系统实际结果，例如 PR 是否已存在。",
					"核实前不重复创建、不用新幂等键重放，也不把查询失败当作没有产生效果。",
					"需要人工对账时由获准人员处理，再依据确认结果继续。",
				],
			},
			{
				title: "撤销的层次",
				paragraphs: [
					"撤销某个 Consumer/Actor 的 Grant 只影响目标授权；撤销设备实例只影响该实例；撤销 PAT 影响复用该枚令牌的全部消费端；断开 Connection 影响依赖该账号的调用。",
					"撤权阻止新的调用，不把已经派发的外部操作撤销或自动回滚。若用户实际 scope 已被外部服务扩大或凭证失效，按服务提示修复，不静默绕过。",
				],
			},
		],
	},
	{
		id: "13",
		title: "管理员与操作记录",
		summary: "目录、审批、Consumer、共享账号分别治理。",
		sections: [
			{
				title: "管理员职责",
				paragraphs: [
					"“审批管理”维护已发布的能力包、免责声明、审批策略和资格；“Agent 接入”管理获准 Consumer、实例、声明与固定回调；“共享 Connection”维护账号和员工资格；“管理员”管理角色。",
					"管理员不凭角色取得其他用户账号或共享 Connection 使用资格，也不能替普通用户选择外部账号、授权或完成公司审批。",
				],
			},
			{
				title: "查询与审计",
				paragraphs: [
					"“操作记录”按当前身份和获准范围展示调用状态、效果与关联信息。普通用户只能访问自己的获准记录，管理员按独立的审计权限查询。记录不公开 Provider Credential、PAT、LDAP 密码或普通会话正文。",
					"查询失败时保留脱敏错误码、调用 ID、时间与服务信息。不能以另一条成功调用证明本次成功，也不能用控制台页面可见性替代服务端授权。",
				],
			},
		],
	},
	{
		id: "14",
		title: "排障与安全使用",
		summary: "按身份、账号、资格、Consumer 授权和调用结果逐层检查。",
		sections: [
			{
				title: "常见排查顺序",
				paragraphs: [],
				steps: [
					"无法登录：核对公司账号、公开 HTTPS 入口及认证服务提示。",
					"服务不可用：核对发布状态、实际 Provider deployment 与目录提示。",
					"不能连接：检查前置申请、资格有效期、能力包和 Provider 鉴权。",
					"客户端没有能力：确认当前 Consumer、账号和 Action Grant，不把登录成功当作已授权。",
					"第二台设备重复登录失败：区分实例认证与 Provider 账号；不要拷贝 refresh token。",
					"PAT 不可用：检查期限、撤销状态、对应 Consumer 和 Action 授权。",
					"升级或重连失败：核对账号是否变化、scope、Credential 状态和任务要求。",
					"写入超时：先回读原调用并对账，不盲目重复执行。",
				],
			},
			{
				title: "反馈问题",
				paragraphs: [
					"提供时间、页面、Provider、客户端版本、脱敏错误码及调用或申请 ID。不要发送密码、Cookie、PAT、OAuth token、Provider Credential 或完整私密会话。",
					"本指南说明 Connection 的产品流程；实际开放能力及客户端兼容性以当前部署目录与验收为准。正式规则见 Connection PRD/HLD，运行与发布见 Connection 生产部署说明。",
				],
			},
		],
	},
];
export function guideChapter(id: unknown) {
	return guideChapters.find((item) => item.id === id) ?? guideChapters[0];
}
export function guideText(item: GuideChapter) {
	return [
		item.title,
		item.summary,
		...item.sections.flatMap((section) => [
			section.title,
			...section.paragraphs,
			...(section.steps ?? []),
			section.code ?? "",
		]),
	].join(" ");
}
export function guideMarkdown() {
	return (
		"# Connection 使用说明书\n\n本说明与 Connection Web 共用一份内容，适用于 Connection 的当前产品流程。实际能力以部署发布目录及客户端验收为准。\n\n" +
		guideChapters
			.map(
				(item) =>
					`## ${item.id} · ${item.title}\n\n${item.summary}\n\n` +
					item.sections
						.map(
							(section) =>
								`### ${section.title}\n\n` +
								section.paragraphs.map((text) => text + "\n\n").join("") +
								(section.steps
									?.map((text, i) => `${i + 1}. ${text}\n`)
									.join("") ?? "") +
								(section.steps ? "\n" : "") +
								(section.code
									? "```" +
										(section.language ?? "text") +
										"\n" +
										section.code +
										"\n```\n\n"
									: ""),
						)
						.join(""),
			)
			.join("") +
		"## 权威文档\n\n- [Connection PRD](../prd/PRD-connection-M1.md)\n- [Connection HLD](../architecture/HLD-connection-M1.md)\n- [Connection 生产部署](../architecture/connection-production.md)\n"
	);
}
