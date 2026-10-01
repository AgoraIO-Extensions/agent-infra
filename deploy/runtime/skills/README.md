# 固定 workspace-summary 包

本包是第一方有界说明，不是 Codex 官方内置 Skill。它只描述已经获准的文本读取；安装不增加工具、网络或文件权限。

`workspace-summary.manifest.json` 位于包外。v1 只允许一个 `SKILL.md`，以原始 bytes 的长度和 SHA-256 组成完整库存。全包摘要输入为 UTF-8 JSON：键顺序 `domain`、`files`，无额外空白，末尾恰一个 LF：

```json
{"domain":"agent-infra.skill-package.v1","files":[["SKILL.md",1373,"af9ba615c92dcf53c6d5742b3d6043e4452b4499e0cdb561f4748033881472b2"]]}
```

Dockerfile 在固定 `/opt/codex/agent-infra-skills` 安装包与 manifest，在 `/opt/codex/share/workspace-summary-build.json` 保存实际 `SOURCE_COMMIT`、manifest 与全包摘要。新镜像启用 `AGENT_INFRA_RUNTIME_INSTALLED_SKILL=workspace-summary-v1`；旧未配置镜像保留不支持行为。Codex 启动先核完整库存、只读 owner/mode、不可替换祖先、build 绑定和官方安装，再把 concrete descriptor 与原 configVersion 交给 Driver。任一校验失败均脱敏拒绝，不返回空成功。

## 镜像安装验收

在已授权的隔离资源窗口，用 Node 24 执行以下命令；镜像必须是当前干净 head 的实际 image ID，配置版本来自该部署，session ID 与窗口资源归属一致：

```sh
node tests/runtime-installed-skill-image.ts "$image_id" "$test_image_id" "$(git rev-parse HEAD)" \
  "$config_version" "$evidence_path" "$session_id"
```

默认 `runner` 保持正式部署层；专用 `installed-skill-test` target 复用同次 builder 工具/源码，仅整根复制同次 runtime 的 `/opt/codex`。分别取得两个 target 的实际 image ID，不重新安装或挂载候选包。脚本核对两层完整库存 bytes/owner/mode 与同一 source revision，在测试层直接调用原 configuration reader，记录真实 immutable descriptor、configVersion 和源码摘要；不新增生产 export，也不启动原生进程。

检查读取真实镜像内容、来源标签、官方 provenance 和模式，并以镜像默认 `node` 用户在一次性可写 overlay 中尝试写入、删除、替换和换包，证明 UNIX owner/mode 拒绝操作。容器无网络和业务挂载，退出即清理。报告区分 image ID 与可用的 OCI/Registry digest，不把准备值当成实际 digest。

该检查只证明安装。原生 config/set/list、完整来源准入、Skill 加载、工具效果、授权、API/Web 与四 Runtime 验收仍归后续消费者；不得用安装或目录 metadata 代签。
