# Agent Runtime 上游版本与兼容性

本模块的 Driver 通过统一 Runtime 接口接入固定上游。下表只记录已实际验证的 Pi RPC 版本；具体产品验收仍以当前部署的镜像、授权和端到端运行结果为准。

## Pi RPC 0.86.0

| 项目 | 固定值与来源 |
| --- | --- |
| 上游包 | 精确依赖见 [package.json](package.json) |
| 源码 commit 与 CLI bundle | 上游 commit、文件数量和组合 SHA-256 见 [Pi release metadata](src/pi-release.json)；许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) |
| 安装闭包 | [根锁文件](../../pnpm-lock.yaml) 固定实际传递依赖。Pi 子包的 `^0.86.0` 在当前 lock 解析为 `0.86.1`；这与上游包携带的 npm shrinkwrap 中 `0.86.0` 不相同 |
| 协议来源 | Pi RPC 由 [pi-rpc.ts](src/pi-rpc.ts) 适配固定上游包；本模块未提交独立生成的 Pi RPC Schema。Host wire Schema 由 `@agent-infra/contracts/runtime` 维护 |

| 能力与边界 | 验证入口 | 0.86.0 结果 |
| --- | --- | --- |
| 包身份与 CLI bundle 字节 | [pi-installation.ts](src/pi-installation.ts) 的 `verifyPiInstallation()` | 通过：版本、54 文件及组合 hash 相符；不启动原生 CLI |
| RPC 请求关联、错误隔离与 owned cleanup | [pi-rpc.test.ts](src/pi-rpc.test.ts) | 3/3 通过；原生进程由 mock 替代 |
| Session/Turn、取消、恢复与异常终态的 Driver 适配 | [pi-runtime-driver.test.ts](src/pi-runtime-driver.test.ts) | 22/22 通过；使用合成 peer 与临时 session，覆盖结构化 system 前缀、输入绑定、异常终态和恢复；不是官方 CLI |
| 官方 Pi CLI 的文本完成、原生历史恢复和模型切换 | [pi-native.test.ts](src/pi-native.test.ts) | 1/1 通过；固定官方 CLI 与离线模型 fixture 验证文本终态、原生历史恢复、同一 Session 的模型切换及不可信项目配置拒绝。旧未确认 Turn 若没有 `prompt-binding.sha256`，恢复时仍为 `unknown`；不代表真实 Relay 模型或附件兼容 |
| read/write/edit 文件策略 | [pi-policy.test.ts](src/pi-policy.test.ts) | 3/3 通过；仅验证 read/write/edit 策略判断 |
| 统一 Host/Grant/Store conformance | [runtime-driver-conformance.test.ts](src/runtime-driver-conformance.test.ts) | 46/46 通过；共享 fixture 覆盖 Pi 与其他 Driver，不代表真实模型或部署授权验收 |

本矩阵只记录固定 Pi 版本与上述测试入口的兼容性。漏洞告警由 GitHub 仓库安全功能维护；标准模板、真实模型、附件、Connection 和生产环境验收仍须按各自的验证入口执行。
