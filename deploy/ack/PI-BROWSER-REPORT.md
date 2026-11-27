# Pi 普通 Web 对话的浏览器与报告验收

本次验收使用两位测试用户、一个已准入 Pi 候选镜像和一个可从 Session Sandbox 访问的受控站点。站点服务每次运行只服务一个 run ID，并在第一次点击时生成一个随机值。站点日志保存 run ID、点击数和值的 SHA-256，可与最终报告逐字节核对。

## 准备本次测试

在受控测试站点用 Node 24 启动下面的服务。将该服务挂到本次测试的独立 HTTPS origin，保留进程输出。本次运行中重启服务或出现第二次点击，应使用新的 run ID 重跑。

```bash
RUN_ID=$(node -p 'crypto.randomUUID()')
node tests/local-real-e2e/pi-browser-test-site.ts "$RUN_ID" 8080
```

从与本次实现 commit 对应的已发布 Pi 镜像取目标架构的子 manifest digest。将 `PI_IMAGE` 设为完整的 `repository@sha256:…`，将 `PI_CANDIDATE_TAG` 指向验收镜像仓库的独立 tag。使用该原镜像配置生成候选 OCI label，随后以新 digest 进入模板 Registry 的正式准入与预检。浏览器能力需要该声明和本次 Sandbox 的签名 readiness 及实际 Chromium 探测共同成立。[Runtime HLD §4.2](../../docs/architecture/HLD-agent-runtime-M1.md#42-browser-capability)

```bash
SOURCE_COMMIT=$(git rev-parse HEAD)
crane config "$PI_IMAGE" > "$EVIDENCE/pi-base-config.json"
node deploy/ack/pi-browser-candidate.ts "$EVIDENCE/pi-base-config.json" \
  "$SOURCE_COMMIT" "$SITE_ORIGIN" > "$EVIDENCE/pi-candidate-manifest.json"
crane mutate "$PI_IMAGE" --tag "$PI_CANDIDATE_TAG" \
  --label "io.agora.agent.runtime.manifest=$(cat "$EVIDENCE/pi-candidate-manifest.json")"
CANDIDATE_DIGEST=$(crane digest "$PI_CANDIDATE_TAG")
crane config "${PI_CANDIDATE_REPOSITORY}@${CANDIDATE_DIGEST}" \
  | jq -r '.config.Labels["io.agora.agent.runtime.manifest"]' \
  | diff - "$EVIDENCE/pi-candidate-manifest.json"
```

通过本次验收环境的模板发布流程采用该候选，以同一 Runtime 路径与模型配置创建测试 Agent。核对实际 Session Sandbox 的准入策略允许该站点。保存源码版本、采用的子 manifest digest、Runtime 路径、Sandbox 标识、generation、fence 以及 Chromium、Playwright 和 probe 时间。[ACK 验收流程](./ACK-REDEPLOY-WORKFLOW.md)

## 在 Web 中验证

1. 第一位用户打开测试 Agent 的新对话。将 `<测试页>` 替换为 `$SITE_ORIGIN/runs/$RUN_ID` 后，发送下面的消息。

   > 请打开 <测试页>，观察页面并点击一次 “Show test value”。再观察页面，读取显示的本次值。将这个值原样写入 report.txt，文件只含该值，不加换行。在最终回复中给我这份文件的链接。

2. 从同一 Execution 核对导航、点击前观察、一次交互、点击后观察的已完成操作及其绑定。检查站点进程的全部点击记录，确认最终计数为 1。
3. 从最终回复中打开 `report.txt` 的预览，再点击下载。核对预览值和下载内容，并用 `shasum -a 256 report.txt` 比较站点日志中的 `valueSha256`。
4. 分别使用第二位已登录的测试用户，以及第一位用户新建的另一对话，沿会话文件访问接口读取原文件。两种请求均应得到 404。核对原对话仍能访问。
5. 在独立回执中记录测试时间、版本、镜像及哈希化的 Conversation、Execution、Sandbox、File ID、浏览器操作与各读请求的 HTTP 状态。报告内容和站点记录用 SHA-256 对照。登录信息及 File Grant 仅用于本次请求。
