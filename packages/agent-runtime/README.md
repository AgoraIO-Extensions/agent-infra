# Agent Runtime 上游版本与兼容性

本模块的 Driver 通过统一 Runtime 接口接入固定上游。下表记录固定上游的产物、协议接缝和受控验证；具体产品验收仍以当前部署的镜像、授权和端到端运行结果为准。

## Protected Connection MCP compatibility

受保护的 Connection MCP 只在已有安全的 Runtime 内部 transport 时开放。固定 Pi 0.99.0 通过显式 `pi-extension-loopback-v1` gate 使用官方 MCP extension；固定 OpenCode 1.19.0 的 ACP HTTP MCP 接缝通过显式 `acp-loopback-v1` gate 开放。两者都只把短期 loopback bearer 传给原生进程，Connection token 仍留在 Host 的 `StandardMcpClient`。

Claude 使用已审核的 SDK 内部 MCP bridge；Host 只把受保护的 client input 交给 Claude Driver，token 不进入 Claude 原生进程的环境、参数或配置。

| Runtime | 固定上游 | 当前结论 |
| --- | --- | --- |
| Pi RPC | `@earendil-works/pi-coding-agent@0.99.0`，commit `4b060d3a98618019adb9985d517516c8e99a2bbe` | 官方 MCP extension 通过 Host-owned loopback bridge 接入，Connection token 不进入 Pi extension 配置 |
| Generic ACP/OpenCode | OpenCode `1.19.0`，commit `733b2c627e5aec39cb33cc22373bdce33053ef2c`；Host ACP SDK `1.4.0`，上游 ACP SDK `0.21.0` | `session/new` 接收 HTTP MCP server，Host-owned loopback bridge 通过显式 `acp-loopback-v1` gate；Connection token 不进入原生进程 |

只有通过固定产物哈希、协议接缝和显式 capability gate 的上游，才可以增加接入；Pi 的上游限制仍保留。

## Pi RPC 0.99.0

| 项目 | 固定值与来源 |
| --- | --- |
| 上游包 | 精确依赖见 [package.json](package.json) |
| 源码 commit 与 CLI bundle | 上游 commit、文件数量和组合 SHA-256 见 [Pi release metadata](src/pi-release.json)；许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) |
| 安装闭包 | [根锁文件](../../pnpm-lock.yaml) 固定实际传递依赖，官方 `0.99.0` npm 包携带的 MCP extension 与其依赖闭包按 lock 解析 |
| 协议来源 | Pi RPC 由 [pi-rpc.ts](src/pi-rpc.ts) 适配固定上游包；本模块未提交独立生成的 Pi RPC Schema。Host wire Schema 由 `@agent-infra/contracts/runtime` 维护 |

| 能力与边界 | 验证入口 | 0.99.0 结果 |
| --- | --- | --- |
| 包身份与 CLI bundle 字节 | [pi-installation.ts](src/pi-installation.ts) 的 `verifyPiInstallation()` | 通过：版本、54 文件及组合 hash 相符；不启动原生 CLI |
| RPC 请求关联、错误隔离与 owned cleanup | [pi-rpc.test.ts](src/pi-rpc.test.ts) | 3/3 通过；原生进程由 mock 替代 |
| Session/Turn、取消、恢复与异常终态的 Driver 适配 | [pi-runtime-driver.test.ts](src/pi-runtime-driver.test.ts) | 22/22 通过；使用合成 peer 与临时 session，覆盖结构化 system 前缀、输入绑定、异常终态和恢复；不是官方 CLI |
| 官方 Pi CLI 的文本完成、原生历史恢复和模型切换 | [pi-native.test.ts](src/pi-native.test.ts) | 1/1 通过；固定官方 CLI 与离线模型 fixture 验证文本终态、原生历史恢复、同一 Session 的模型切换及不可信项目配置拒绝。旧未确认 Turn 若没有 `prompt-binding.sha256`，恢复时仍为 `unknown`；不代表真实 Relay 模型或附件兼容 |
| read/write/edit 文件策略 | [pi-policy.test.ts](src/pi-policy.test.ts) | 3/3 通过；仅验证 read/write/edit 策略判断 |
| 统一 Host/Grant/Store conformance | [runtime-driver-conformance.test.ts](src/runtime-driver-conformance.test.ts) | 46/46 通过；共享 fixture 覆盖 Pi 与其他 Driver，不代表真实模型或部署授权验收 |

本矩阵只记录固定 Pi 版本与上述测试入口的兼容性。漏洞告警由 GitHub 仓库安全功能维护；标准模板、真实模型、附件、Connection 和生产环境验收仍须按各自的验证入口执行。

## 原生 Shell 子边界（#3218）

Claude、Pi 与 OpenCode 的原生命令通过镜像内只读 TypeScript launcher 安装完整 ABI5 Landlock
规则，再启动 Bash。子进程只可写当前 Conversation 的工作区和存在的 canonical memory 目录，
只读固定系统/Skill 目录；显式环境白名单与仅继承 stdio 的新进程隔断 native/Host 凭证及额外 FD。
缺 helper、ABI5 或合法目录时拒绝执行，不使用弱权限重试。`/etc/ssl/openssl.cnf` 仅作为不可写
系统文件提供给 Node/OpenSSL，不开放整个 `/etc`。

- Pi 使用固定上游 `createBashToolDefinition`，保留原生执行、取消和输出逻辑。能力名
  `sandbox_bash` 避免扩展加载失败时回退到 builtin `bash`；用户工具事实显示 Bash。
- OpenCode 固定配置的 shell 指向 launcher，ACP execute 只在初始及本次真实准入通过后批准；
  受信 OpenCode 的 execute 事件映射为 Bash 事实，不改变自定义 ACP 的工具身份。
- Claude 的固定 `CLAUDE_CODE_SHELL` 指向只读 `native-bash.mjs` alias；声明 Bash 前以及每次
  权限调用都检查 alias/helper 不可写、无符号链接、内容一致并实际执行 ABI5 准入。原生配置与
  历史保持在工作区外，shell 临时文件留在工作区。平台后端不要求放宽容器 namespace 权限。

既有固定 Linux conformance 通过 `AGENT_INFRA_NATIVE_SHELL_TEST=1` 强制运行三个模板的真实
原生工具调用。矩阵覆盖环境、Host/native/兄弟目录、proc、符号链接、继承 FD、非法启动输入、
取消、组合/后台命令、工作区/memory 成功路径、工具事实、重启不重放与准入失效拒绝。受控模型
fixture 与真实外部模型验收分别记录，不互相代签。工程约束见
[Spec §10.14](../../docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md#1014-标准模板-session-sandbox-原生工具)。
