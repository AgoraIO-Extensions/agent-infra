# Custom Agent self-managed Web fixture

这是 #1267 的受控自有身份 Web 样例。它只发布一个 `8080` Service 端口，Manifest 的健康路径是 `/healthz`，业务页面是 `/`（`/app` 是同一页面的显式别名）。镜像使用固定 Node OCI digest，未继承 ACP 或其他 Agent 样例镜像。`SAMPLE_VERSION` build arg 会作为不敏感的页面修订标识，供 A→B 路由切换测试确认内容来自候选镜像。

服务端从 `CUSTOM_AGENT_AUTH_FILE` 读取 Owner 身份体系提供的 JSON 文件，并在每个请求重新读取。文件必须是进程用户可读的 `0600` 普通文件，内容形如：

```json
{"users":[{"subject":"owner-1","token":"<generated-token>","permissions":["web:read"]},{"subject":"viewer-1","token":"<generated-token>","permissions":[]}]}
```

`Authorization: Bearer <token>` 是唯一自有身份凭证。匿名请求、无效凭证和只有浏览器身份 Header 的请求返回空 body 的 `401`；凭证属于无 `web:read` 权限的主体时返回空 body 的 `403`。合法主体的页面只显示转义后的主体标识、`self-managed` 责任和当前就绪状态，绝不回显凭证。

样例明确不实现平台身份入口：`x-agent-infra-platform-context` 等平台上下文 Header 不会被自有入口信任，`/platform-auth` 也不存在。#1268 的 Auth Gateway、签名上下文、Key 轮换和真实 LDAP/浏览器验收由其独立实现与验收负责；本 fixture 不构成这些能力的替代证据。

构建时只使用本文件所在目录作为 Docker context：

```bash
docker build --build-arg SAMPLE_VERSION=sample-a --file tests/fixtures/custom-agent-web/Dockerfile --tag custom-agent-web:local tests/fixtures/custom-agent-web
docker run --rm --publish 8080:8080 \
  --env CUSTOM_AGENT_AUTH_FILE=/run/secrets/custom-agent-auth \
  --mount type=bind,src=/path/to/0600/auth.json,dst=/run/secrets/custom-agent-auth,readonly \
  custom-agent-web:local
```

这是 fixture 和脚本契约测试；它不能证明获准 Registry Digest、Kubernetes/Ingress/TLS、Gateway、真实身份目录或浏览器环境已经可用。

## Platform identity verifier fixture

`platform-auth-server.mjs` 是独立的应用端 verifier fixture。它消费
`x-agent-infra-platform-context` 的 `platform-entry-jws` token，校验 issuer、audience、Agent、
key version、期限和主体授权 revision；授权文件每次请求回读，因此撤权和显式 key rotation
可以在 Node 测试中复验。它只证明应用端合同语义，不提供 Gateway、LDAP、Kubernetes route/TLS
或浏览器实现。

`Dockerfile.platform-auth` 是同一 verifier 的 platform-managed identity sample image。它仍使用
`self-managed` interaction mode，因为应用负责 Web 页面和 Session；平台身份只由 Auth Gateway
经 `x-agent-infra-platform-context` Header 注入。启动时需要以下部署挂载或环境变量：

- `PLATFORM_AUTH_PUBLIC_KEYS_FILE`：`0600` 普通文件，内容为 `{"keys":{"k1":"<Ed25519 public PEM>"}}`。
- `PLATFORM_AUTH_AUTHORIZATION_FILE`：`0600` 普通文件，内容为 `{"users":[{"userId":"alice","authorizationRevision":"r1"}]}`。
- `PLATFORM_AUTH_ISSUER` 和 `PLATFORM_AUTH_AGENT_ID`：与 Gateway 签发上下文一致。
- 可选 `PLATFORM_AUTH_VERSION` 和 `PORT`（默认 `8080`）。

构建时只使用本目录作为 Docker context：

```bash
docker build --build-arg SAMPLE_VERSION=sample-platform-auth \
  --file tests/fixtures/custom-agent-web/Dockerfile.platform-auth \
  --tag custom-agent-platform-auth:local tests/fixtures/custom-agent-web
```

这仍是 verifier fixture 和 image contract；固定 Digest、Gateway、LDAP、Kubernetes/TLS、真实
浏览器和 key rotation 的生产验收需要独立证据。
