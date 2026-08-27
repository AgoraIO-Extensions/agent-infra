# Wire Contract 使用 Zod authoring 与标准发布产物

Agent Platform M1 在 `packages/contracts` 的 Platform-owned namespaces 中只手写 Zod 4 Schema，再单向生成并提交 OpenAPI 3.1 和 JSON Schema 2020-12。OpenAPI 是浏览器及内部 HTTP 消费者评审和兼容检查的规范发布产物，其中浏览器 OpenAPI 也是 TypeScript Client 的生成输入；JSON Schema 是 SSE payload、Runtime Manifest 等非 HTTP Contract 的机器校验产物。两者都不是反向修改 Zod 的入口。这样让 TypeScript 实现共享一套运行时校验来源，同时让跨进程消费者依赖与实现框架无关的标准产物。

## Considered Options

- 手写 OpenAPI/JSON Schema 再生成 Zod：拒绝，因为运行时校验需要反向生成链并增加语义漂移风险。
- 维护独立通用 Schema IR：拒绝，因为它形成第三套模型和额外工具链，而 M1 没有真实调用方需要该抽象。

## Consequences

生成工具必须固定版本，标准产物必须通过漂移、breaking-change 和 consumer contract 检查。调用方不能直接编辑生成产物，`packages/contracts` 也不能暴露 Hono、React、Drizzle、Kubernetes 或领域/数据库类型。本决策不定义 Connection 内部 Provider、OAuth、凭证或 Action Schema；只有 Platform-to-Connection delegated contract 属于该 Platform authority。
