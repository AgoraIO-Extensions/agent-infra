# Runtime Host Connection 安装接收

Host 启动时可消费部署批准的私有文件 export，随后使用已有标准 MCP reader。
完整信任、秘密保护、发布与失败规则以
[工程 Spec §13.5.5](../../docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md#1355-受保护安装交付)
为准。这里只说明当前文件交付格式，不提供 Connection 签发或登录接口。

## 来源与格式

受控 Runtime 启动配置中的 `AGENT_INFRA_RUNTIME_CONNECTION_INSTALLATION_REVISION`
为非秘密 JSON `[supplyRef, supplyRevision]`；两项均是最多 128 字符的引用标识，允许字母、
数字、点、下划线、冒号和连字符，首字符为字母或数字。完整 Consumer 快照继续通过
已有 `AGENT_INFRA_RUNTIME_CONNECTION_CONSUMER_FILE`/`REVISION` 接收；安装供应选择
不能补齐或覆盖该快照。Worker/Platform 不读取或运输 export 的 token。

源目录固定在当前 `dataDirectory` 下的
`codex-driver.json.native/conversations/standard-mcp-export/<exportKey>`。
`exportKey` 是 `[supplyRef, supplyRevision]` 经 `JSON.stringify` 后 UTF-8 字节的 SHA-256
小写十六进制；不接受额外路径或 URL。源与目标均属于原 native/tool 共享拒绝树。

- `manifest.json`：最多 8,192 bytes，字段仅为 `schemaVersion: 1`、`delivery`（供应
  `{ ref, revision }`）、`configFingerprint`、Consumer 的 `source`，以及 1–32 个唯一
  64 位小写十六进制 `installationKeys`。完整目标及来源必须与受控配置一致。
- `bindings/<installationKey>.json`：现有版本 1 安装 metadata，上限 65,536 bytes；
  不含 `scope` 或 `token`，使用原 principal 与 Pod Agent 复算安装 key。字段规则复用
  [Runtime 校验器](../../packages/agent-runtime/src/standard-mcp-client.ts)。
- `materials/<materialKey>.token`：分离的原样 material，上限 4,096 bytes，仍须满足
  现有 token 字符/长度限制。材料 key 复用安装 key、credentialRef 与 credentialRevision。

供应方在获准的秘密边界交付文件：目录由 Host UID 持有且为 `0700`，文件为 `0400` 或
`0600`，不使用路径别名、符号链接、硬链接或特殊文件。供应修订不可变；相同修订不能换
成其他内容。metadata 与文件名不构成 Connection 身份、独立确认或当前授权证明。

## MCP schema 版本

工具输入和获准结果 schema 未声明 `$schema` 时，按 JSON Schema 2020-12 校验；显式
`https://json-schema.org/draft/2020-12/schema`（可带尾部 `#`）使用同一版本。另支持显式
`http://json-schema.org/draft-07/schema`（可带尾部 `#`）以兼容旧合同；旧 tuple schema
需要显式声明 draft-07。未知版本或非标准 `$async` validator 拒绝，不静默回退。嵌入 schema resource 可声明同一
版本，未知或不同版本拒绝；const/default/enum/examples 中的 JSON 数据不改作 schema。

仍限制 schema 字节数、节点与深度，只允许本地 `$ref`，拒绝原 profile 未批准的
`$dynamicRef` / `$recursiveRef`；不会联网加载 schema。此校验不扩大工具或 Grant 权限，
结果不满足批准合同仍保持原 unknown。依据见
[MCP 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/index#json-schema-usage)
与 [Ajv 版本说明](https://ajv.js.org/json-schema.html#json-schema-versions)。

## 启动与故障

`assembleRuntimeHost` 打开原 Store 后、装配客户端前调用
`receiveProtectedStandardMcpInstallation`，先确认真实进程保护，再校验固定来源并发布。
material 持久确认先于 metadata 切换；切换后确认失败不承诺旧绑定仍在。已配置来源失败
使该客户端保持不可用，stop/status 和原事实读取保留；不回退旧安装或其他 token。
已配置清单之外的残留绑定不再可选，已有 Thread 工具快照和 unknown 占用保持。

接收使用专用 `.receive.lock` 排斥并行安装，不承担业务状态或授权职责。崩溃留下的锁不按
PID/时间自动删除；须由原受控恢复流程确认安装写权与同一引用的发布结果后处理。
删除文件或重启不表示服务端已撤销；Host 不运行来源监听、刷新或业务重发循环。

该源码入口不证明合法供应已部署。实际供应输出、公开且部署匹配的服务合同、两主体/两
Agent 的真实 token 与 Linux/Runtime/Connection/Provider 验证继续沿
[#851](https://github.com/AgoraIO-Extensions/agent-infra/issues/851)；通过前不启用实际 token。
