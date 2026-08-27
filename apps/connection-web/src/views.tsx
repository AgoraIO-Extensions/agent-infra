import type {
	Connection,
	IssuedToken,
	TokenRecord,
} from "@agent-infra/connection-contracts";
import {
	Copy,
	KeyRound,
	Link2,
	LogIn,
	RefreshCw,
	ShieldCheck,
	Trash2,
} from "lucide-react";
import type { FormEvent, ReactNode } from "react";

export function LoginView(props: {
	busy: boolean;
	error: string | null;
	onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
	return (
		<main className="login-layout">
			<section className="login-brand" aria-label="Connection">
				<div className="brand-lockup">
					<span className="brand-mark" aria-hidden="true">
						C
					</span>
					<span>Connection</span>
				</div>
				<p>统一管理你的外部账号、访问授权和 AI 客户端连接。</p>
			</section>
			<section className="login-panel" aria-labelledby="login-title">
				<div>
					<h1 id="login-title">登录 Connection</h1>
					<p className="lead">使用公司账号继续。</p>
				</div>
				{props.error ? (
					<p className="alert alert-error" role="alert">
						{props.error}
					</p>
				) : null}
				<form className="form-stack" onSubmit={props.onSubmit}>
					<label htmlFor="username">公司账号</label>
					<input
						id="username"
						name="username"
						type="text"
						autoComplete="username"
						maxLength={256}
						required
					/>
					<label htmlFor="password">密码</label>
					<input
						id="password"
						name="password"
						type="password"
						autoComplete="current-password"
						maxLength={1024}
						required
					/>
					<button
						className="button button-primary"
						type="submit"
						disabled={props.busy}
					>
						<LogIn aria-hidden="true" size={17} />
						{props.busy ? "正在登录" : "登录"}
					</button>
				</form>
			</section>
		</main>
	);
}

export function PageHeader(props: { action?: ReactNode; title: string }) {
	return (
		<header className="page-header">
			<h1>{props.title}</h1>
			{props.action}
		</header>
	);
}

export function EmptyState(props: { children: ReactNode; title: string }) {
	return (
		<div className="empty-state">
			<h2>{props.title}</h2>
			<p>{props.children}</p>
		</div>
	);
}

export function TokensView(props: {
	busy: boolean;
	issued: IssuedToken | null;
	onCopy?: () => void;
	onIssue: (event: FormEvent<HTMLFormElement>) => void;
	onRevoke: (tokenId: string) => void;
	tokens: TokenRecord[];
}) {
	return (
		<div className="content-stack">
			<section className="toolbar-section">
				<form className="inline-form" onSubmit={props.onIssue}>
					<div className="field-grow">
						<label htmlFor="token-name">令牌名称</label>
						<input
							id="token-name"
							name="name"
							maxLength={100}
							placeholder="例如：Codex 本机"
							required
						/>
					</div>
					<button
						className="button button-primary"
						type="submit"
						disabled={props.busy}
					>
						<KeyRound aria-hidden="true" size={17} />
						{props.busy ? "正在签发" : "签发令牌"}
					</button>
				</form>
			</section>

			{props.issued ? (
				<section className="secret-callout" aria-live="polite">
					<div>
						<h2>令牌已签发，只显示一次</h2>
						<p>离开本页后将无法再次查看明文。</p>
					</div>
					<code>{props.issued.token}</code>
					{props.onCopy ? (
						<button
							className="button button-secondary"
							type="button"
							onClick={props.onCopy}
						>
							<Copy aria-hidden="true" size={16} />
							复制
						</button>
					) : null}
				</section>
			) : null}

			<section className="data-section" aria-labelledby="tokens-title">
				<div className="section-heading">
					<div>
						<h2 id="tokens-title">访问令牌</h2>
						<p>为不同客户端分别签发，便于独立撤销和审计。</p>
					</div>
				</div>
				{props.tokens.length ? (
					<div className="table-scroll">
						<table>
							<thead>
								<tr>
									<th>名称</th>
									<th>状态</th>
									<th>创建时间</th>
									<th>到期时间</th>
									<th className="table-action">操作</th>
								</tr>
							</thead>
							<tbody>
								{props.tokens.map((token) => (
									<tr key={token.tokenId}>
										<td className="primary-cell">{token.name}</td>
										<td>
											<Status value={token.status} />
										</td>
										<td>{formatTime(token.createdAt)}</td>
										<td>{formatTime(token.expiresAt)}</td>
										<td className="table-action">
											<button
												className="icon-button danger"
												type="button"
												onClick={() => props.onRevoke(token.tokenId)}
												aria-label={`撤销 ${token.name}`}
												title="撤销令牌"
											>
												<Trash2 aria-hidden="true" size={17} />
											</button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				) : (
					<EmptyState title="还没有访问令牌">
						签发一个令牌后，它会显示在这里。
					</EmptyState>
				)}
			</section>
		</div>
	);
}

export function ConnectionsView(props: {
	connections: Connection[];
	onAuthorize: (connectionId: string) => void;
	onDisconnect: (connectionId: string) => void;
	onReconnect: (connectionId: string) => void;
}) {
	if (!props.connections.length) {
		return (
			<EmptyState title="还没有 Connection">
				连接 GitHub 或公司 Bitbucket 账号后即可授权给你的客户端。
			</EmptyState>
		);
	}
	return (
		<div className="connection-list">
			{props.connections.map((connection) => (
				<article className="connection-row" key={connection.id}>
					<div className="connection-icon" aria-hidden="true">
						<Link2 size={20} />
					</div>
					<div className="connection-main">
						<div className="connection-title-line">
							<h2>{connection.displayName}</h2>
							<span className="ownership-badge">
								{providerLabel(connection.providerId)}
							</span>
							<span className="ownership-badge">
								{connection.ownerType === "PERSONAL" ? "个人" : "共享"}
							</span>
						</div>
						<p>{connection.externalAccount}</p>
					</div>
					<Status value={connection.status} />
					<div className="row-actions">
						{connection.requiresReconnect ? (
							<button
								className="button button-secondary"
								type="button"
								onClick={() => props.onReconnect(connection.id)}
							>
								<RefreshCw aria-hidden="true" size={16} />
								重新连接
							</button>
						) : (
							<button
								className="button button-secondary"
								type="button"
								onClick={() => props.onAuthorize(connection.id)}
							>
								<ShieldCheck aria-hidden="true" size={16} />
								授权客户端
							</button>
						)}
						{connection.ownerType === "PERSONAL" ? (
							<button
								className="icon-button danger"
								type="button"
								onClick={() => props.onDisconnect(connection.id)}
								aria-label={`断开 ${connection.displayName}`}
								title="断开 Connection"
							>
								<Trash2 aria-hidden="true" size={17} />
							</button>
						) : null}
					</div>
				</article>
			))}
		</div>
	);
}

export function Status(props: { value: string }) {
	const active = props.value === "ACTIVE";
	return (
		<span className={`status ${active ? "status-active" : "status-muted"}`}>
			{active ? "正常" : statusLabel(props.value)}
		</span>
	);
}

function statusLabel(value: string) {
	return (
		{
			DISCONNECTED: "已断开",
			DISABLED: "已停用",
			PAUSED_CONNECTION: "Connection 已暂停",
			PAUSED_CREDENTIAL: "凭证已暂停",
			REPLACED: "已被替换",
			REVOKED: "已撤销",
			SUSPENDED: "已暂停",
			TERMINATED: "已终止",
		}[value] ?? value
	);
}

export function providerLabel(value: string) {
	return { bitbucket: "Bitbucket", github: "GitHub" }[value] ?? value;
}

function formatTime(value: string) {
	return new Intl.DateTimeFormat("zh-CN", {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(value));
}
