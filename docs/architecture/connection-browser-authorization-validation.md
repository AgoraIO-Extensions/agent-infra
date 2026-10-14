# Connection 浏览器授权验收

行为依据为 [Connection HLD](HLD-connection-M1.md#162-api-keypat) 与
[PAT Binding ADR](../adr/ADR-connection-agent-pat-binding.md)。本清单用于实现与发布验收，
不另行定义身份或权限。浏览器重定向可能丢失来源或 Cookie；前者可以由防伪证明兼容，后者必须
重新认证，不能以一次性 URL 值代替身份校验。

## 路由覆盖

| 入口 | 防护与恢复 | 验证入口 |
| --- | --- | --- |
| 公司 OAuth entry/check | 准入与 LDAP 身份分离；中断 POST 只恢复原授权 GET | company-oauth-entry-routes.test.ts |
| 公司 OAuth callback GET/POST | state Cookie、code hash、用途与期限绑定；重复参数拒绝；失败可重新登录 | company-oauth-entry.test.ts、browser-confirmation.test.ts、company-oauth-entry-routes.test.ts |
| 原生 OAuth authorize/login | PKCE 与原请求仍有效；匿名 Cookie/request proof；密码校验前拒绝非法证明 | app.test.ts、oauth-routes.integration.test.ts |
| 原生 OAuth recovery GET | 只打开未批准、未消费、未过期且客户端/实例有效的原请求；不登录、不签发 | oauth-routes.integration.test.ts |
| PAT 授权 GET/confirm POST | proof 绑定当前会话/Principal/绑定/origin；GET 不签发；原子单次确认 | app.test.ts、pat-binding-repository.integration.test.ts |
| Browser JSON 写接口 | 全部现有写接口共用来源校验；缺失/null 来源需 Cookie 和 Header proof，仍检查会话/角色/Grant | app.test.ts、browser-confirmation.test.ts |
| 匿名 browser-confirmation GET | 只签发防伪证明，无身份、权限或业务数据；no-store；短期 host-only Cookie | app.test.ts、browser-confirmation.test.ts |
| 管理员身份探测 | proof 绑定管理员会话和事务；角色撤销/账号变化拒绝；原命令只消费一次 | identity-probe-routes.integration.test.ts |
| GitHub/Manhattan/DataLego OAuth callback | 保留 Provider state/PKCE/owner 事务；拒绝重复参数；失败返回连接页重新发起 | app.test.ts |
| 机器 DCR/token/revoke、MCP/metadata | 不套浏览器 proof 或公司准入 Cookie，保留各协议认证 | app.test.ts、company-oauth-entry-routes.test.ts、oauth-routes.integration.test.ts |
| PAT 后端 create/claim 与客户端 callback | 服务凭据/固定 callback/单次领取不变；URL 无 PAT | app.test.ts、pat-binding-repository.integration.test.ts |
| Web 请求与账号切换 | bootstrap 合并并发、内存短期缓存；防伪失败清缓存但不重试写请求；登录清业务缓存 | browser-confirmation.test.ts、connection.login.test.tsx |
| Web nginx/入口恢复 | query 不进 access log，流程路径脱敏；中断 POST 不重放 | scaffold-policy.test.mjs、connection-hci-ingress.test.mjs |

同名测试分别位于 API、Core、Store、Web 包；检查时以实际测试断言为准，不能把未启用数据库的
skipped 测试记作通过。仓库 nginx 日志检查不能替代平台 Ingress 日志的生产门禁。
connection-hci-ingress.test.mjs 只验证已退役模板的历史路由边界，不用于启用新 HCI 插件。

## 发布后的真实浏览器验收

1. 在企业微信打开客户端返回的原始 authorizationUrl，完成公司准入、Connection 登录与确认，
   检查回到已注册客户端，后端只领取一次 PAT。Chrome/Safari 同样验收。
2. 检查正常 Origin、null Origin 与缺失 Origin；明确跨域来源必须拒绝。不要通过手工修改生产
   Cookie、粘贴凭据或循环提交业务写操作做验收。
3. 等待页面 proof 过期，点击确认应提示重新打开；恢复链接只打开 GET 页面，必须再次核对账号。
4. 在内置浏览器打开、系统浏览器继续，检查 Cookie 丢失时要求重新登录而非自动授权；复制的
   入口不能包含密码、PAT 或 proof。若客户端自己的 callback Cookie 丢失，其会话恢复由客户端负责。
5. 切换 Connection 账号，旧确认页必须失效，控制台不显示上一账号的缓存数据；核对原客户端
   的用户/会话与 bindingId 关联仍由该客户端后端隔离。
6. 检查客户端取消、重复 GET、链接扫描及并发确认不多签发；已消费、过期请求不得被恢复为有效。
7. 只收集固定错误分类/错误编号和状态码，核对 Web 与 Ingress 不记录 query、Cookie、请求体或
   不透明流程标识。真实企业微信版本、系统与结果记录在发布验收中。

外部浏览器若完全阻止 Cookie 或删除必要流程参数，必须安全失败并重新发起；不能承诺任意
浏览器条件下 100% 完成授权，也不能为兼容性降低权限边界。
