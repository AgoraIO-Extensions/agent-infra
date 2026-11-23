# 执行影响看板

系统管理员从平台运维页打开 Grafana，按最近一小时查看执行结果。
本看板以单一环境的 Platform DB 为数据范围，共库的多个环境需要先提供独立的授权投影。

## 部署

1. 在目标库由专用非超级用户安装 [聚合函数](execution-impact.sql)。
   函数所有者需要 platform schema 的 USAGE 和函数引用列的 SELECT。
   目标 schema 归该受信角色所有，数据源账号只获得下面两项函数的调用权。
2. 在系统管理员专用的 Grafana 组织或等效数据源权限范围内创建 PostgreSQL 数据源。
   使用专用只读登录角色，设置查询超时和连接数上限，并启用 TLS 服务端校验。
   用普通账号直接访问数据源、看板和平台深链，核对拒绝结果。
3. 导入[看板 JSON](execution-impact.json)，选择数据源，并填写本环境平台的完整 HTTPS /ops 地址。
   在现有 operations 配置中设置 dashboardUrl 为保存后的 HTTPS 看板地址。API 重新加载配置后，
   系统管理员在「定位入口」可以打开看板。删除该配置项可移除入口。
4. 按现场数据量核对查询计划与耗时，记录实际数据覆盖和刷新周期。
   默认窗口一小时，单次查询最多一天，每五分钟一个趋势点。点击 Agent 行回到运维历史区间。

具名数据源账号仅授予 schema USAGE 与两个函数的 EXECUTE，例如以已建立的专用角色执行以下授权。

```sql
GRANT USAGE ON SCHEMA platform_ops_dashboard TO dashboard_reader;
GRANT EXECUTE ON FUNCTION platform_ops_dashboard.failed_sessions(timestamptz,timestamptz)
  TO dashboard_reader;
GRANT EXECUTE ON FUNCTION platform_ops_dashboard.execution_impact(timestamptz,timestamptz,text)
  TO dashboard_reader;
GRANT EXECUTE ON FUNCTION platform_ops_dashboard.first_output(timestamptz,timestamptz)
  TO dashboard_reader;
```

## 时间与覆盖

按创建时间统计受理，按已确认终态时间统计成功、失败、取消；缺终态时间的旧记录按受理窗口单列。
同一人跨五分钟桶的失败在整窗重新去重。失败率分母为成功加失败，分母为零时显示无样本。
待核实显示所选窗口受理且当前为 unknown 的执行数。

首正文表使用第一次持久化非空正文的服务端时间，等待数取当前活动执行，包含所选窗口前已开始的等待。
一个用户在同一渠道有多个等待仍计一人；取消终结该次执行的等待。按渠道单列，跨渠道人数不可相加。
回复耗时统计窗口内受理且已有正文的样本。浏览器实际展示、企微送达和 API 客户端收到时间仍需独立回执。

## 专用 Grafana 的文件配置

在发布工作区执行下列命令生成看板和数据源配置。输出目录须为新目录。部署工具应将产物和源版本关联。

```sh
node deploy/observability/grafana/provision.mts ./dashboard-release https://platform.example.invalid/ops
```

独立 Helm release 通过网关逐请求核对平台会话的系统管理员权限，Grafana Viewer 仅监听 Pod 回环。
使用已有受管工作区时，组织 1 限定为系统管理员，关闭匿名、自助注册和默认组织自动加入。
两种部署都须核对成员撤权后，面板及数据源直接访问被拒。

将输出中的两个 provisioning 子目录内容分别装配到 Grafana 的 dashboards、datasources 配置目录。
将 dashboards 中的看板文件挂载到 `/etc/grafana/platform-dashboards`，将数据库根证书挂载到
`/etc/grafana/platform-ca/ca.crt`。通过部署配置提供 OPS_PG_HOSTPORT、OPS_PG_DATABASE、OPS_PG_USER，
通过受管 Secret 注入 OPS_PG_PASSWORD。使用具备证书匹配主机名的 PostgreSQL TLS 端点。
数据源使用独立账号，设置适合现场负载的数据库 statement_timeout。

Grafana 重启后从文件恢复固定 UID 的数据源和看板。将该面板的 HTTPS 地址配置到正式 /ops，
停止临时预览的采样与端口转发，由第二位管理员重新登录查看新样本。
