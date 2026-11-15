# Signed own-entry artifact promotion

现有 `publish-signed-own-entry.yml` 默认继续构建单镜像。显式设置
`promote_existing=true` 时，仅复制已验证的 c549 fixture，不构建其他镜像。
workflow 必须从 `main` 运行；工作流源码与被复制镜像的源码分别记录。

唯一 publisher 在新有限发布 scope 内执行以下调用，未知结果不得重发：

```sh
gh workflow run publish-signed-own-entry.yml --ref main \
  -f source_sha=4a3c2840e0d918dfc6fef77ce1cb1b7fffc46c60 \
  -f promote_existing=true
```

promotion helper 固定检查官方 origin run `43741080676` attempt 1 成功、
workflow 源 `334a244152ddef9baba24bcd7eb4fbfc7735317b`、原 artifact 的 bytes hash，
以及 `custom-agent-web-signed@sha256:45cf40eb5595b0fd48af1f73ae1324aa06793f72e07858413fea7f7362686051`。
它校验 linux/amd64、source label、显式 self-managed runtime manifest 和启动入口。
来源、digest 和目标仓库不是调用方可选参数；其他 artifact 需要新的受评审绑定。

目标仅为现有 `agent-runtime-codex` 仓库下
`ownentry-45cf40eb5595-<runId>-1` 新 tag，不覆盖标准模板 release tag、latest 或已有 tag。
使用正常 Docker Registry reader/copy，复制前必须明确确认目标不存在；授权或网络错误不能代替 NotFound。
同源发布与 promotion 共用并发组，生产环境继续保持唯一 publisher。

复制前独占写入 `COPY_STARTED` intent，后续失败保留它；不支持 workflow rerun 自动重放。
只有 tag 与 immutable target 的 manifest、config 和全部 layer descriptors 均与来源一致，才写出
`VERIFIED` receipt。回执在 Actions artifact
`signed-own-entry-promotion-<runId>-<attempt>` 中保留，包含两侧仓库/digest、config/layer hashes、
原发布证据与本次 workflow/run 身份。不上传凭据、环境值或镜像 layer 内容。

promotion 证明内容相同，不证明部署、Owner 授权或 cache 可用性，也不按仓库名推断 Runtime 角色。
同一 c549 的正常 Owner 升级、完整 main/init/sidecar/materializer 投影、Registry policy、
配置/CAS、snapshot/PVC 保留和严格 TLS/prefix 验收仍走原正式流程。
