import type { GuideChapter } from "./content.ts";

// The chapter is shared by the help page, connection entry and Markdown export.
export const providerGuideChapters: Record<string, GuideChapter> = {
	github: {
		id: "15",
		title: "GitHub 接入",
		summary: "通过 GitHub OAuth 连接自己的账号，不需要手工创建 PAT。",
		sections: [
			{
				title: "GitHub · 账号与入口",
				paragraphs: [
					"先确认能用自己的 GitHub 账号访问 https://github.com/ 的目标仓库。组织仓库还受组织成员、SSO 和应用访问策略限制。",
				],
			},
			{
				title: "GitHub · 连接步骤",
				paragraphs: [],
				steps: [
					"在 GitHub 连接入口检查公司审批是否启用；若启用，先申请并等待通过。",
					"点击连接账号，前往 GitHub OAuth 页面，核对账号、应用与授权范围后确认。无需在 Connection 填写 GitHub 密码或 PAT。",
					"返回 Connection 核对外部账号，再选择 Consumer、Action 并确认授权。",
				],
			},
			{
				title: "GitHub · 验证与常见问题",
				paragraphs: [
					"先调用 github.get_current_user，确认是自己的账号，再读取有权限的仓库。OAuth 成功不等于能访问所有组织仓库；仓库 403/404 时检查 GitHub 权限、组织 SSO 和应用策略。连接失败与某个仓库不可见是不同问题。",
				],
			},
		],
	},
	bitbucket: {
		id: "16",
		title: "Bitbucket 接入",
		summary: "使用公司 Bitbucket Server 的个人访问令牌。",
		sections: [
			{
				title: "Bitbucket · 获取凭据",
				paragraphs: [
					"登录 https://bitbucket.agoralab.co/ ，打开头像下的个人账户设置，在 Personal access tokens 中创建个人 Token。按需要的仓库读取/写入范围及有效期选择权限；没有该入口时联系 Bitbucket 管理员，不使用 SSH 私钥代替 Token。",
				],
			},
			{
				title: "Bitbucket · 连接步骤",
				paragraphs: [],
				steps: [
					"进入 Bitbucket 连接入口；公司审批启用时先取得所需能力的资格。",
					"将自己的个人 Token 填入 Bitbucket 专用表单，提交后检查返回的账号。不要填写公司密码或 Connection PAT。",
					"选择 Consumer 和所需 Action，预览并确认授权。",
				],
			},
			{
				title: "Bitbucket · 验证与权限",
				paragraphs: [
					"先调用 bitbucket.get_current_user，再读取自己有权限的仓库。Token 权限、仓库权限与 Connection Action 授权共同限制实际操作；Token 可读不代表能创建或合并 PR。401 检查 Token 到期/撤销，403 检查 Token 范围和仓库权限。",
				],
			},
		],
	},
	jira: {
		id: "17",
		title: "Jira 接入",
		summary:
			"当前公司 Jira Server 使用 Jira 用户名和密码，不是 Atlassian Cloud API Token。",
		sections: [
			{
				title: "Jira · 账号准备",
				paragraphs: [
					"先在 https://jira.agoralab.co/ 确认自己的 Jira 账号可登录、能查看目标项目。Connection 登录与 Jira 鉴权分开；用户名表单的默认邮箱仍需核对是否是实际 Jira 用户名。",
				],
			},
			{
				title: "Jira · 连接步骤",
				paragraphs: [],
				steps: [
					"进入 Jira 连接入口，按页面完成公司审批（若启用）。",
					"在 Jira 专用表单填写 Jira 用户名和密码。凭据由 Connection 加密保存，只在网页提交，不发送给 AI。",
					"核对外部账号，选择 Consumer 与需要的 Action，确认授权。",
				],
			},
			{
				title: "Jira · 验证与权限",
				paragraphs: [
					"先调用 jira.get_current_user，再查看有权限的项目或 Issue。项目浏览、编辑、评论和工作流流转权限仍由 Jira 控制。浏览器已登录但连接失败时，检查实际账号密码及 Jira 认证限制；不要用 Cloud Token 或 Bitbucket PAT 替代密码。",
				],
			},
		],
	},
	confluence: {
		id: "18",
		title: "Confluence 接入",
		summary:
			"使用公司 Confluence Server 的用户名和密码，空间权限仍由 Confluence 控制。",
		sections: [
			{
				title: "Confluence · 账号准备",
				paragraphs: [
					"先在 https://confluence.agoralab.co/ 确认自己的账号能登录并打开目标空间/页面。此接入不是 Atlassian Cloud OAuth 或 Cloud API Token。",
				],
			},
			{
				title: "Confluence · 连接步骤",
				paragraphs: [],
				steps: [
					"进入 Confluence 连接入口，公司审批启用时先完成申请。",
					"在专用表单填写 Confluence 用户名和密码，核对默认用户名；凭据只在 Connection 页面提交并加密保存。",
					"核对外部账号，再为 Consumer 选择、确认所需 Action。",
				],
			},
			{
				title: "Confluence · 验证与权限",
				paragraphs: [
					"先调用 confluence.get_current_user，再读取自己能访问的页面。连接成功不会授予空间或页面编辑权限。403/404 可能来自空间权限或页面限制；修改前需要当前页面信息和对应编辑权限。",
				],
			},
		],
	},
	"jenkins-ci": {
		id: "19",
		title: "Jenkins CI 接入",
		summary: "使用 CI 部署中的 Jenkins 用户名与个人 API Token。",
		sections: [
			{
				title: "Jenkins CI · 获取 API Token",
				paragraphs: [
					"打开公司 Jenkins CI 入口，核对目标为 Jenkins CI（服务入口 https://jenkins-ci.agoralab.co/）。点击自己的用户进入配置，在 API Token 中创建具名 Token；入口不可用或没有生成权限时联系该部署管理员。这里需要 API Token，不是公司密码。",
				],
			},
			{
				title: "Jenkins CI · 连接步骤",
				paragraphs: [],
				steps: [
					"在 Connection 选择 Jenkins CI；不要误选 Jenkins Release。公司审批启用时先完成申请。",
					"填写该 CI 部署中的实际 Jenkins 用户名和个人 API Token，不提交服务 URL 或其他部署的凭据。",
					"验证账号后选择 Consumer 和所需 Action，确认授权。",
				],
			},
			{
				title: "Jenkins CI · 首次验证与排障",
				paragraphs: [
					"先调用 jenkins-ci.get_current_user，再用 list_jobs 查看获准 Job。目录读取不会启动构建。Job 权限仍由 Jenkins 控制；网关 IP restriction/403 可能是服务出口限制，不要因此反复更换个人 Token。",
				],
			},
		],
	},
	"jenkins-release": {
		id: "20",
		title: "Jenkins Release 接入",
		summary: "Release 与 CI 是两个独立部署，分别取得凭据和授权。",
		sections: [
			{
				title: "Jenkins Release · 获取 API Token",
				paragraphs: [
					"从团队提供的 Jenkins Release 入口登录自己的账号；没有入口时联系 Release 管理员取得该部署地址。点击自己的用户进入配置，在 API Token 中创建具名 Token。不要在不受信任的地址填写凭据，也不要假定 CI Token 可跨部署使用。",
				],
			},
			{
				title: "Jenkins Release · 连接步骤",
				paragraphs: [],
				steps: [
					"在 Connection 选择 Jenkins Release，检查并完成该部署的公司审批（若启用）。",
					"填写 Release 部署的 Jenkins 用户名和 API Token；接口目标由 Connection 固定，不需要自己输入地址。",
					"核对账号，为 Consumer 单独选择 Release Action 并确认授权。",
				],
			},
			{
				title: "Jenkins Release · 首次验证与排障",
				paragraphs: [
					"先调用 jenkins-release.get_current_user，再用 list_jobs 查看获准 Job，不触发构建或发布。Release Job 的读取/执行权限与 CI 分开；连接成功不代表能发布。认证失败检查部署、用户名和 Token；网关拒绝则交由服务管理员排查出口。",
				],
			},
		],
	},
	rehoboam: {
		id: "21",
		title: "Rehoboam 接入",
		summary: "从自己的 Rehoboam Security 页面取得个人 PAT。",
		sections: [
			{
				title: "Rehoboam · 获取凭据",
				paragraphs: [
					"登录 https://justinia.gz3.agoralab.co/ ，在个人 Security 页面创建 PAT。基础发现使用 metadata:read；发布写操作需要 release:write，其他操作按页面范围选择。只选择实际需要的权限，不使用机器 API Key 或其他人的 PAT。",
				],
			},
			{
				title: "Rehoboam · 连接步骤",
				paragraphs: [],
				steps: [
					"选择 Rehoboam，按页面要求完成公司审批（若启用）。",
					"把个人 PAT 填入 Rehoboam PAT 表单，提交后核对账号；不填写公司密码。",
					"选择 Consumer 和具体 Action，阅读预览后确认。PAT scope 与 Action 授权都需要满足。",
				],
			},
			{
				title: "Rehoboam · 首次验证与效果",
				paragraphs: [
					"先调用 rehoboam.get_current_user，再查询有权限的模板或版本。创建、启动流水线、提测、交付和通知有不同效果；先预览，再明确确认，不能用一次连接授权代替业务操作确认。403 检查 PAT scope、资源角色及 Consumer Action。",
				],
			},
		],
	},
	manhattan: {
		id: "22",
		title: "Manhattan 接入",
		summary:
			"使用公司 OAuth 登录，不再在 Connection 提交公司密码或个人 Token。",
		sections: [
			{
				title: "Manhattan · 账号准备",
				paragraphs: [
					"先确认自己的公司账号可以访问 https://manhattan.agoralab.co/ 。连接使用公司 OAuth 验证个人身份，SDK/Symbol 等资源权限另行判断。",
				],
			},
			{
				title: "Manhattan · 连接步骤",
				paragraphs: [],
				steps: [
					"选择 Manhattan；若要求公司审批，先按页面申请。",
					"点击连接账号，在公司 OAuth 页面完成登录和授权，返回 Connection；不要填写手工 Token 或共享 Cookie。",
					"核对个人账号，选择 Consumer 和需要的 Action，确认授权。",
				],
			},
			{
				title: "Manhattan · 验证与排障",
				paragraphs: [
					"先调用 manhattan.get_current_user。账号验证成功不要求已拥有全部 SDK API 权限，实际 SDK/Symbol 路由可能返回 403。资源权限向 Manhattan 管理员申请；连接回跳失败则按页面检查 OAuth 状态，不重复使用旧 callback 链接。",
				],
			},
		],
	},
	datalego: {
		id: "23",
		title: "DataLego 接入",
		summary: "通过公司 OAuth 连接个人账号，查询资格与表权限另行检查。",
		sections: [
			{
				title: "DataLego · 账号准备",
				paragraphs: [
					"先确认公司账号可以访问 https://datalego.agoralab.co/ 和目标数据源。当前 DataLego 使用公司 OAuth，不需要手工从 Grafana 复制 Token、Cookie 或密码。",
				],
			},
			{
				title: "DataLego · 连接步骤",
				paragraphs: [],
				steps: [
					"选择 DataLego，按页面完成公司审批（若启用）。",
					"点击连接，前往公司 OAuth 页面完成个人授权，返回后核对账号。",
					"选择 Consumer 和所需 Action，确认授权；新增能力需要单独确认，不自动进入旧 Grant。",
				],
			},
			{
				title: "DataLego · 验证与查询",
				paragraphs: [
					"先调用 datalego.get_current_user。列出表、查看表结构和 SQL 查询会创建查询任务，属于 WRITE，不作为无副作用连接验证。实际表权限仍由数据源控制；查询提交成功不代表任务已完成，需要查询任务状态。OAuth 失效按重连提示处理，表权限不足联系数据 Owner。",
				],
			},
		],
	},
	"static-spaces": {
		id: "24",
		title: "StaticSpaces 接入",
		summary: "个人 API Token、Connection 授权和空间访问权限是三件不同的事。",
		sections: [
			{
				title: "StaticSpaces · 取得自己的个人 API Token",
				paragraphs: [],
				steps: [
					"打开 StaticSpaces 门户，用自己的公司账号登录：https://auth-static-spaces.sh3.agoralab.co/if/user/#/library 。",
					"进入账号设置的凭据页面：https://auth-static-spaces.sh3.agoralab.co/if/user/#/settings 。在 Tokens / App passwords 中创建个人 API Token，intent 选择 API，不使用 App password 或浏览器 Cookie。",
					"为 Token 设置可识别名称和适当有效期，创建后保存到安全位置；只填写 Connection 专用表单，不发送给 AI。找不到创建入口时联系 StaticSpaces 管理员。",
				],
			},
			{
				title: "StaticSpaces · 连接并授权",
				paragraphs: [],
				steps: [
					"在 StaticSpaces 连接入口选择需要的能力，公司审批启用时先完成申请。",
					"在“个人 Authentik API Token”表单填写自己的 Token；Connection 验证真实外部账号并加密保存凭据，不需要提供公司密码。",
					"核对返回账号，为当前 Consumer 选择 StaticSpaces full 中需要的 Action，预览后确认。升级新增能力时重新按页面完成审批/Consent，旧 Grant 不自动扩权。",
					"先调用 static-spaces.get_current_user，再读取自己可访问空间中的文件，确认实际权限。",
				],
			},
			{
				title: "StaticSpaces · 发布到哪里与分享给谁",
				paragraphs: [
					"Connection 不限于 connection-test：user 是个人空间，shared 是指定名称的共享空间，public 是所有已登录用户可读的空间；public 不代表匿名公开。能否创建、发布或删除由 StaticSpaces 中的真实权限决定。",
					"共享文档时让空间 owner/manager 为明确邮箱添加 viewer，权限覆盖整个空间，不能仅凭文章链接获得访问权。目录组授权覆盖该组当前及未来成员。连接凭据或选择 StaticSpaces full 不会自动获得所有空间权限或管理员身份。",
					"阅读使用 API 返回的完整 review_url，或从 StaticSpaces 门户打开获准空间。/spaces/shared/ 根目录没有匹配 ACL 时会显示“Forbidden: no ACL rule matched this path”，不代表所有文章都不可读；当前接口禁止给这个命名空间根开放 ACL。",
				],
			},
			{
				title: "StaticSpaces · 常见问题与验证",
				paragraphs: [
					"完整文章链接仍被拒绝：核对浏览器登录账号是否与获准邮箱相同，联系该空间 owner/manager 检查成员资格。管理员 Action 返回 403：当前 Token 对应账号不是 StaticSpaces 管理员，Connection 管理员角色不能替代它。",
					"401 或 Token 到期/撤销：在上游检查个人 Token，再按 Connection 提示重连；普通内容 403 是权限不足，不等于 Token 必然失效。发表评论前读取最新 Markdown SHA；DOCUMENT_CHANGED 时重新读取。写入结果未知时先对账，不换 key 重试。",
				],
			},
		],
	},
};

export function providerGuideHref(providerId: string) {
	const chapter = providerGuideChapters[providerId];
	return chapter
		? `/connection/help?chapter=${chapter.id}`
		: "/connection/help?chapter=03";
}
