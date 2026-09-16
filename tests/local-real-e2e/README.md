# 本地浏览器开发入口

此测试工具让正式 Web、Platform API 和 Worker 使用受控开发身份联调。它不实现产品
身份服务，不创建账号、业务数据或 Workload，也不证明真实登录、模型、Connection 授权或
GitHub PR 首通。真实验收仍使用部署 IdentityAdapter 和专用测试账号。

## 配置与启动

先启动本机 Web 和 API。在仓库外创建仅当前用户可读的配置文件，使用独立开发主体的
受控 token 文件和浏览器信任的本地 TLS 证书。不能恢复已撤权的主体，不能复用或修改
已有恢复任务。token 只由此工具读取，不写进 Web 构建、URL、日志或浏览器存储。

```json
{
  "schemaVersion": 1,
  "mode": "controlled-development",
  "port": 3511,
  "browserHostname": "127.0.0.1",
  "apiOrigin": "http://127.0.0.1:3508",
  "webOrigin": "http://127.0.0.1:3001",
  "tls": {
    "certFile": "/absolute/local-development/tls.crt",
    "keyFile": "/absolute/local-development/tls.key"
  },
  "accounts": [
    {
      "name": "owner",
      "label": "开发 Owner",
      "tokenFile": "/absolute/local-development/owner-token"
    },
    {
      "name": "admin",
      "label": "开发审批管理员",
      "tokenFile": "/absolute/local-development/admin-token"
    }
  ]
}
```

配置、TLS 私钥及 token 文件必须是当前用户拥有的普通文件，权限不向其他用户开放
（例如 `0600`）；不接受文件符号链接。上游仅接受显式 loopback IP 的 HTTP/HTTPS origin，
无路径、凭证和查询参数。HTTPS 上游使用 Node 默认的证书验证。

使用 Node 24 从仓库根启动：

```bash
node tests/local-real-e2e/local-browser.ts /absolute/local-development/config.json
```

打开 `https://127.0.0.1:3511/__local/login` 选择开发身份；退出入口为
`/__local/logout`。Web 部署可将登录与退出链接指向这两个同源地址，并持续显示受控开发
标识。本工具不需要修改现有 Vite 代理；页面和资源经同一个 HTTPS origin 转发。
HMR WebSocket 不转发，修改 Web 后重新加载页面。

登录前工具用服务端 token 查询正式 `/api/v1/session`，仅成功后建立最多一小时的
HttpOnly、Secure、SameSite=Strict opaque 会话。切换或退出撤销旧会话并整页跳转到
`/agents`。退出、切换或会话到期会结束该会话已有的 API/SSE 连接。真实身份仍由 API 和
Worker 在操作时重新解析。

申请仍必须填写模型配置。开发用的模板、模型端点、模型、推理档位和合成模型凭证必须
来自同一受控部署；此工具不注入、改写或替换业务请求，也不替用户提交申请。不要把真实
凭证改成合成值后报告真实模型成功。

按 `Ctrl+C` 只停止此浏览器入口并清除内存会话；不停止 Web/API/Worker，不删除数据。

## 验证

测试使用临时本机 HTTP 服务、临时合成 token 和 OpenSSL 生成的一日 TLS 证书；不连接
现有后端、不读取部署凭证、不创建业务数据。TLS 客户端明确信任该测试证书。

```bash
node --test tests/local-real-e2e/local-browser.test.ts
```

覆盖配置和私密文件权限、实际登录会话校验、Cookie 属性、匿名与伪造身份、Host/Origin/
CSRF 拒绝、调用方身份头与上游 Cookie 隔离、切换与退出、禁止上游重定向，以及 SSE 的
即时转发和断连取消。测试通过仅证明受控开发入口行为。
