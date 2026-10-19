import { Clock } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { LoginAction } from "./login-action";

type LoginPageProps = {
	/** 部署配置的登录入口；未配置时只显示说明。 */
	loginUrl?: string;
	/** 受控开发模式：跳转到开发测试身份选择，不渲染账号密码表单。 */
	development: boolean;
	/** 已就绪的会话失效（非主动退出），或地址带 reason=expired。 */
	expired: boolean;
	onLoggedIn: () => Promise<unknown>;
};

/**
 * 设计 login.html：确认未登录后整页渲染，不渲染应用侧栏、顶栏与身份卡。
 * 保持当前 URL，登录成功后由壳层直接显示原目标页，不引入跳转参数。
 */
export function LoginPage({
	loginUrl,
	development,
	expired,
	onLoggedIn,
}: LoginPageProps) {
	return (
		<div className="login-page">
			<header className="login-header">
				<div className="login-brand">
					<span className="login-brand-mark" aria-hidden="true">
						A
					</span>
					<span className="login-brand-name">Agora Agent</span>
				</div>
				<span className="login-context">企业内部工作区</span>
			</header>
			<main id="main-content" className="login-main">
				<section className="login-panel" aria-labelledby="login-title">
					<div className="login-intro">
						<p className="login-kicker">公司账号</p>
						<h1 id="login-title">登录工作区</h1>
						<p className="login-lead">使用公司账号登录。</p>
					</div>
					{expired && (
						// 过期提示是 intro 之下独立的 status 块，不替换 lead（NI-109）。
						<div className="login-expired" role="status">
							<Clock aria-hidden="true" />
							<div>
								<strong>登录已过期，请重新登录</strong>
								<p>已提交的任务会继续处理。</p>
							</div>
						</div>
					)}
					{loginUrl ? (
						development ? (
							<a
								className={buttonVariants({ className: "login-submit" })}
								href={loginUrl}
							>
								选择开发测试身份
							</a>
						) : (
							<LoginAction endpoint={loginUrl} onLoggedIn={onLoggedIn} />
						)
					) : (
						<p className="login-unconfigured">登录入口尚未配置。</p>
					)}
					<p className="login-help">账号由公司管理。无法登录时联系 IT 支持。</p>
				</section>
			</main>
			<footer className="login-footer">
				<p>仅限公司授权账号访问。</p>
			</footer>
		</div>
	);
}
