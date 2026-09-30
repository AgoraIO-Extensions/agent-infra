# Agent Runtime 上游版本与兼容性

本模块的 Driver 通过统一 Runtime 接口接入固定上游。下表只记录已实际验证的 Pi RPC 版本；具体产品验收仍以当前部署的镜像、授权和端到端运行结果为准。

## Pi RPC 0.86.0

| 项目 | 固定值与来源 |
| --- | --- |
| 上游包 | `@earendil-works/pi-coding-agent@0.86.0`，精确依赖见 `package.json` |
| 源码 commit | `ecac0a9c4edad3dac5d9f8b40e0c7db7a56471fc` |
| CLI bundle | 54 个 JS 文件；组合 SHA-256 `01e2d340926e625c0886ee3c360a369a68b483c1414e79595741aab9ceef0b8a`；固定值见 `src/pi-release.json` |
| 安装闭包 | 根 `pnpm-lock.yaml` 固定实际传递依赖。Pi 子包的 `^0.86.0` 在当前 lock 解析为 `0.86.1`；这与上游包携带的 npm shrinkwrap 中 `0.86.0` 不相同 |
| 协议来源 | Pi RPC 由 `src/pi-rpc.ts` 适配固定上游包；本模块未提交独立生成的 Pi RPC Schema。Host wire Schema 由 `@agent-infra/contracts/runtime` 维护 |

| 能力与边界 | 验证入口 | 0.86.0 结果 |
| --- | --- | --- |
| 包身份与 CLI bundle 字节 | `src/pi-installation.ts` 的 `verifyPiInstallation()` | 通过：版本、54 文件及组合 hash 相符；不启动原生 CLI |
| RPC 请求关联、错误隔离与 owned cleanup | `src/pi-rpc.test.ts` | 3/3 通过；原生进程由 mock 替代 |
| Session/Turn、取消、恢复与异常终态的 Driver 适配 | `src/pi-runtime-driver.test.ts` | 22/22 通过；使用合成 peer 与临时 session，覆盖结构化 system 前缀、输入绑定、异常终态和恢复；不是官方 CLI |
| 官方 Pi CLI 的文本完成、原生历史恢复和模型切换 | `src/pi-native.test.ts` | 1/1 通过；固定官方 CLI 与离线模型 fixture 验证文本终态、原生历史恢复、同一 Session 的模型切换及不可信项目配置拒绝。旧未确认 Turn 若没有 `prompt-binding.sha256`，恢复时仍为 `unknown`；不代表真实 Relay 模型或附件兼容 |
| read/write/edit 文件策略 | `src/pi-policy.test.ts` | 3/3 通过；仅验证 read/write/edit 策略判断 |
| 统一 Host/Grant/Store conformance | `src/runtime-driver-conformance.test.ts` | 46/46 通过；共享 fixture 覆盖 Pi 与其他 Driver，不代表真实模型或部署授权验收 |

当前 lock 已移除 Pi 外部 `undici@8.9.0`，保留官方 `undici@8.10.2`；候选镜像的扫描与 downloaded-evidence policy 尚未运行。上游 CLI bundle 中的 brace-expansion 风险及镜像全局 npm 的剩余风险仍须单独处理。完整仓库测试曾在无默认 Docker socket 的隔离环境因 `file-authority` 的 PostgreSQL 容器启动失败，不能记作通过。上述局部测试不代表标准模板、真实模型、附件、Connection 或生产环境验收。
