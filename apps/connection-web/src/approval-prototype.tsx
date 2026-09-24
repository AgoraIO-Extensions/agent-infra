import { Bell, Cable, ChevronRight, Clock3, KeyRound, Search, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "./components/ui/button";
import "./index.css";
import "./approval-prototype.css";
import { connectorDefinitions } from "./views";

const variants = [
	{ key: "A", name: "原页面内联审批" },
	{ key: "B", name: "原页面审批时间线" },
	{ key: "C", name: "原页面待办抽屉" },
] as const;

function Prototype() {
	const initial = Math.max(0, variants.findIndex((item) => item.key === new URLSearchParams(location.search).get("variant")));
	const [index, setIndex] = useState(initial);
	const variant = variants[index] ?? variants[0];
	const change = (next: number) => {
		const normalized = (next + variants.length) % variants.length;
		setIndex(normalized);
		const query = new URLSearchParams(location.search);
		query.set("variant", variants[normalized].key);
		history.replaceState(null, "", `${location.pathname}?${query}`);
	};
	useEffect(() => {
		const listener = (event: KeyboardEvent) => {
			if (event.key === "ArrowLeft") change(index - 1);
			if (event.key === "ArrowRight") change(index + 1);
		};
		addEventListener("keydown", listener);
		return () => removeEventListener("keydown", listener);
	}, [index]);

	return <div className="app-shell">
		<aside className="sidebar"><div className="brand-lockup sidebar-brand"><span className="brand-mark">C</span><span>Connection</span></div><nav aria-label="Connection 导航"><div className="nav-link active"><Cable size={18}/><span>我的 Connection</span></div><div className="nav-link"><KeyRound size={18}/><span>访问令牌</span></div><div className="nav-separator"/><div className="nav-link"><ShieldCheck size={18}/><span>管理员</span></div></nav><div className="account-block"><strong>Guoxianzhe</strong><span>guoxianzhe@agora.io</span></div></aside>
		<main className="main-content">
			<header className="page-header"><div><h1>我的 Connection</h1><p>管理外部账号连接与客户端授权</p></div><button className="prototype-bell" aria-label="待办"><Bell size={18}/><b>2</b></button></header>
			<section className="connection-management-workspace">
				<ConnectorList />
				<div className="connection-provider-detail"><ProviderHeader />{variant.key === "A" ? <InlineApproval/> : variant.key === "B" ? <TimelineApproval/> : <DrawerApproval/>}</div>
			</section>
		</main>
		<div className="prototype-switcher"><button onClick={() => change(index - 1)}>←</button><strong>{variant.key} · {variant.name}</strong><button onClick={() => change(index + 1)}>→</button></div>
	</div>;
}

function ConnectorList() {
	return <aside className="connection-connector-list"><label className="connector-search" htmlFor="prototype-search"><Search size={17}/><span className="sr-only">搜索连接器</span><input id="prototype-search" placeholder="搜索连接器"/></label><strong className="connection-list-label">连接器</strong>{connectorDefinitions.slice(0,7).map((item) => { const Icon=item.icon; const selected=item.providerId === "jira"; return <button className={selected ? "active" : ""} key={item.providerId}><span className="connector-logo"><Icon size={19}/></span><span><b>{item.name}</b><small>{selected ? "审批中 · 第 2/3 级" : item.providerId === "github" ? "已连接 1 个账号" : "未连接"}</small></span><ChevronRight size={16}/></button>; })}</aside>;
}
function ProviderHeader() {
	return <header className="connection-provider-header"><span className="connector-logo"><KeyRound size={20}/></span><div><span>研发协作</span><h2>Jira</h2><p>Issue、项目与研发流程</p></div><Button disabled>审批中</Button></header>;
}
function Progress() { return <ol className="prototype-progress"><li className="done"><b>研发负责人</b><span>已通过 · 9 月 23 日 14:20</span></li><li className="current"><b>数据负责人</b><span>审批中 · 已提醒 1 次</span></li><li><b>安全负责人</b><span>等待前置审批</span></li><li><b>连接 Jira</b><span>全部通过后开放</span></li></ol>; }
function Meta() { return <div className="prototype-meta"><div><span>能力包</span><b>研发协作读写</b></div><div><span>申请时长</span><b>90 天</b></div><div><span>申请有效期</span><b>剩余 11 天</b></div></div>; }

function InlineApproval() {
	return <div className="prototype-existing-body"><div className="connection-subheading"><div><strong>连接申请</strong><p>REQ-2026-0918</p></div><span className="prototype-status">审批中</span></div><Meta/><div className="prototype-inline-message"><Clock3 size={17}/><div><strong>当前无需操作</strong><p>数据负责人正在审核，通过后进入安全负责人审批。</p></div></div><div className="prototype-actions"><Button variant="secondary">查看申请详情</Button><Button variant="danger">取消申请</Button></div></div>;
}
function TimelineApproval() {
	return <div className="prototype-existing-body"><div className="connection-subheading"><div><strong>审批与连接进度</strong><p>申请通过后才能输入凭证或进入 Provider OAuth</p></div><span className="prototype-status">第 2 / 3 级</span></div><Meta/><Progress/><div className="prototype-actions"><Button variant="danger">取消申请</Button></div></div>;
}
function DrawerApproval() {
	return <div className="prototype-existing-body prototype-drawer-host"><div className="connection-inline-empty"><Clock3 size={20}/><strong>Jira 连接申请审批中</strong><p>在右上角待办中查看进度，不改变现有 Connection 管理布局。</p><Button variant="secondary">打开待办</Button></div><aside className="prototype-drawer"><div className="connection-subheading"><div><strong>待办详情</strong><p>Jira · 研发协作读写</p></div><span className="prototype-status">审批中</span></div><Meta/><Progress/><div className="prototype-actions"><Button variant="secondary">查看完整记录</Button><Button variant="danger">取消申请</Button></div></aside></div>;
}

createRoot(document.getElementById("root")!).render(<Prototype/>);
