# Connection 发布签名与完整 SBOM

状态：Accepted。2026-10-10，郭贤哲（`guoxianzhe@agora.io`）明确批准并授权实现。
实现与验证由 [#1744](https://github.com/AgoraIO-Extensions/agent-infra/issues/1744) 跟踪。

## 决定

落实 [Connection HLD §10.3、§13.4、§27.6](../architecture/HLD-connection-M1.md)：现有上海
canonical Connection 发布使用 GitHub Actions OIDC 短期身份和 Sigstore，不保存长期签名私钥。
只接受 repository ID `1316991471`、`AgoraIO-Extensions/agent-infra` 的
`.github/workflows/publish-ghcr.yml` 在 `connection-vX.Y.Z` tag 的 push 发布身份。
证书 issuer、workflow/tag、source SHA、repository immutable ID 必须全部匹配。
允许公开透明日志记录公开发布物 digest 和构建身份，不允许提交凭证、用户正文或个人路径。

签名对象分别为最终 OCI 镜像、Kernel/Provider executor manifest 的保存字节和完整 SBOM 字节。
manifest 使用版本化 UTF-8 JSON 文件契约；签名和 SHA-256 针对实际文件字节，不将重新编码
JSON 当作同一签名对象。OCI attestation 保存 manifest/SBOM 原字节及独立 Sigstore bundle，
读取者先验可信 attestation，再独立验证两个 blob 签名与其 subject/hash。

完整 SBOM 合并最终镜像 scanner 的 OS/安装包/runtime 清单和实际 bundler 输出使用的输入
组件；保留来源、输入 hash 和覆盖范围。实际产物中必须随附 Kernel LICENSE.txt、NOTICE.md、
PROVENANCE.json 和构建清单，不能用源码依赖列表或运行目录快照替代完整镜像证据。

## 实施边界

签名权限只给限定仓库 tag 的 Connection 签名 Job；普通 PR、Fork、Platform 发布 Job 和
运行容器不获得 OIDC 签名权限。工具、Actions 和 scanner 固定 commit/版本/SHA-256。
缺失证据、错身份、篡改、未知覆盖或签名服务失败均拒绝发布和部署，不降级为 unsigned。
canonical 上海部署验证准确 source/tag/image digest 后按 digest 更新镜像；保留原 target/TLS、
单写、Secret/CA 和 migration receipt 门禁。

本决定批准签名信任方案，不代表 Legal 签收、上游 Owner 合同或完整真实 onboarding 已完成。
不改变 Credential KMS、Direct/Delegated 身份或 Action 授权，不重开已关闭 StaticSpaces v2/v3，
不延长原试点，不以技术签名将 UNVERIFIED Provider 转成已验证发布。

## 验证

验证正确发布、错误仓库/issuer/workflow/ref/SHA、篡改字节、缺失许可/组件、签名服务失败和
canonical 部署拒绝路径；当前 PR head CI 和最终已签发布证据分别记录，不能互相替代。
