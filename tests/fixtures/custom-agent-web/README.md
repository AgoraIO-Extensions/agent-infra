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

## 签名身份与多服务示例

`signed-server.ts` 和 `Dockerfile.signed` 提供自有身份的部署样例。应用在端口 `3003` 监听；
`/` 是登录页，`/app` 是受保护页面，按钮通过 `/api/check` 读取服务状态，`/healthz` 仅用于就绪。
匿名或伪造身份不能读取受保护页面；合法但无 `web:read` 的主体被拒绝。签名 token 只通过
应用登录请求或 Authorization 传入，Cookie 使用 Secure、HttpOnly 和 SameSite=Strict。

签名样例同时提供受保护的静态资源 `/assets/protocols.js`、有限 SSE `/api/events` 和
WebSocket `/ws`。SSE 先发 `status`，再发 `complete` 并结束；设置 `X-Accel-Buffering: no`。
WebSocket 在升级前校验原签名身份与精确 HTTPS Origin，只接受一次文本 `check`，返回与
`/api/check` 一致的结果并关闭；禁止 binary、未知指令与超过 4096 bytes 的 payload，连接最长
5 秒。`web` 角色仍从同 Agent 的 `api` Service 读取结果，不新增公开 Service。
`POST /auth/logout` 只在相同 Origin 下清除原 host-only Secure/HttpOnly Cookie；不创建或轮换 Key。
应用页面的按钮可直接操作这些协议，旧路径模式继续将资源、退出和协议 URL 留在原前缀。

镜像仍以非 root 的 `node /app/signed-server.ts` 启动，端口、健康路径、签名配置和快照接口不变。
构建阶段从现有锁文件固定的纯 JS `ws` 依赖生成一个 CommonJS bundle；最终镜像不安装包、
不包含测试密钥，也不需要可选 native addon。真实 c549 采用前仍必须核当前 command/args、
完整镜像集合、两快照和原 PVC；不能强行覆盖不兼容启动参数。

本地正常回归入口：

```bash
node --test tests/signed-own-entry.test.mjs tests/signed-own-entry-protocols.test.mjs tests/snapshot-business.test.mjs
```

它同时测试源码与实际打包结果、401/403、跨应用 audience、伪造身份 Header、Cookie/Origin、
有限帧及快照执行；测试只用隔离临时签名输入，不读取部署私钥。它不签收公开 TLS。
真实验收必须使用同一 deployed tuple 的正常平台链接、默认浏览器 CA 信任、原 Owner/应用签名方
提供的现有授权与拒绝 token；不能生成新现场 Key、跳过证书错误、使用 SPKI 例外或以页面 200
代替 SSE/WebSocket 的实际帧和资源/退出证据。

应用只需要非秘密配置 `CUSTOM_ENTRY_PUBLIC_ORIGIN`、`CUSTOM_ENTRY_PUBLIC_KEY`、`CUSTOM_ENTRY_ISSUER`、`CUSTOM_ENTRY_AUDIENCE`
和 `CUSTOM_ENTRY_ROLE`。私钥留在部署验证端，镜像、普通环境变量和 ConfigMap 都不含凭证。
`CUSTOM_ENTRY_PUBLIC_ORIGIN` 是部署/应用 owner 从正式已选入口绑定的 canonical HTTPS origin，
不是请求 Host、Origin、转发 Header 或 URL 参数。登录、退出与 WebSocket 同时核对这个固定
origin 和 Host；同步伪造 Host+Origin 仍拒绝。新镜像正常采用前须通过原 Owner 的配置入口补齐
此非秘密值，不换 Key、issuer、audience、权限或快照，不强行执行缺配置的 image-only 升级。
现有正常入口为 `PUT /api/v2/agents/{agentId}/configuration` 的 V2 environment 更新：使用原
Owner 会话及新幂等操作，保留 fresh 当前 environment 的全部条目，仅增加或核实此值；不发送
Key/model/权限/快照变更，不编造公开接口没有返回的 revision/CAS。配置与镜像采用均由协调者
绑定实际新有限窗口，当前源码阶段不调用该入口。
`single` 直接提供应用；多服务 manifest 使用 `web` 与 `api` 两个 Deployment/Service，前者按
平台生成的 Pod 名推导同 Agent 的 `api` Service，转发签名身份并显示真实后端返回值。
该命名约定是此样例的约束，不新增平台服务发现契约。

正式发布只由唯一 publisher 在新有限 scope 内调用既有单镜像入口：

```bash
gh workflow run publish-signed-own-entry.yml --ref main -f source_sha="$MERGED_SOURCE_SHA"
```

`MERGED_SOURCE_SHA` 必须是本次实现实际合入的 exact commit；先按正常入口去重并核 source/main
门禁，未知结果不重发。不盲开 full release，不在运维机绕过正常发布工具直接 push。
仅做本地 recipe 验证时从 clean checkout 构建 `Dockerfile.signed`，使用明确 Docker context 与
本地 tag，不 push、采用或替换现场镜像。

真实 ACK 验收由 [重部署工作流](../../../deploy/ack/ACK-REDEPLOY-WORKFLOW.md) 绑定当前 Agent、
全部服务、入口 TLS、浏览器和实际 imageID；本地样例测试不代表这些外部条件已通过。

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

## 工作区快照业务样例

`signed-server.ts` 的 `/api/snapshot-check?input=<0..1000000>` 会在认证后调用固定的
`node` 解释器执行 `/opt/agent/workspaces/repo/main.ts`，该脚本从另一个只读绑定的
`/opt/agent/workspaces/env/dependency.ts` 导入依赖并返回 `repoVersion`、依赖版本和计算结果。HTTP 参数只允许
`input`，服务端不接受路径、模块名或工作区根目录；子进程超时、异常、额外输出和错误 metadata
都折叠为无正文的 503。`web` 角色只把认证身份转发到同 Agent 的 `api` Service，并重新校验
结果，不能直接读取工作区。

`snapshots/repo-v1` 与 `repo-v2` 是测试输入，不会被复制进镜像；ACK 验收必须把它们和
`snapshots/env` 作为三个独立的快照上传。绑定名称固定为 `repo` 和 `env`；两个 repo snapshotId
交替占用同一个 `repo` 绑定，不能再嵌套一层目录。输入 7 时，repo v1 返回 `repoVersion=1`、
`total=55`，切换到 v2 返回 `repoVersion=2`、`total=60`，回滚后再次得到 55。结果摘要可以回显版本和
数值，不能回显源码、路径或环境文件正文。

独立受控发布使用已存在的 `publish-signed-own-entry.yml --ref main`，只提供实际合入的
`source_sha`；保留 main/source 校验、单镜像选择和 linux/amd64，不能为本样例盲开 full release。
旧 full-release 的 `own_entry_fixture=true` 仍兼容。当前推广入口只绑定已验证的旧 45cf 内容；
协议能力变化后的新 artifact 需要真实发布回执与新的受评审固定绑定，不能冒用旧推广回执或覆盖
标准模板 tag。唯一 publisher 执行前按正常流程去重、绑定新有限 scope，镜像仍以 immutable digest
准入。发布会上传 `signed-own-entry-amd64-<sourceSha>-<attempt>` receipt。该 receipt 只可用于同一
source SHA 的私有 ACK capsule；本 fixture 不提供 Platform Task API、Connection supply、
Ingress 或 DNS 证据，相关门禁继续由 #3870 与 #3874 的独立验收处理。
