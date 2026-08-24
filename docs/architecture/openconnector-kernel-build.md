# OpenConnector Kernel 来源记录

本文记录 Connection 内受控 OpenConnector Kernel 的来源与校验方式。这是供应链证据，不代表
Legal 或 Security 发布批准。

| 字段 | 值 |
| --- | --- |
| 源码仓库 | `https://github.com/oomol-lab/open-connector.git` |
| Commit | `0cb0e0dd2ed686fa7fa2ff8d9eef97a7d6b31674` |
| 上游版本 | `@oomol-lab/open-connector@1.3.4` |
| 源 manifest SHA-256 | `1bc27e93d082c3e5e4b78452c080e8ab6723d4f164428960a4865aa1413ec4b8` |
| 源 lock SHA-256 | `d246186fcf13d192afe1cf4f192930fc8d9db231506b733ba57f8fbe6f08fcc2` |
| License SHA-256 | `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4` |
| Notice SHA-256 | `d0890661bf25e7327808610f773b055cb87bf949ff6bba5943c7d62d94d1bf0f` |

`packages/openconnector-kernel` 是 GitHub Provider execution closure 的受控源码副本，不是上游
Runtime Server。`PROVENANCE.json` 记录 allowlist、源文件 digest 和排除边界；执行 test/build 前，
以下命令重新计算实际 package 内容：

```bash
pnpm --filter @agent-infra/openconnector-kernel verify-provenance
```

`openconnector-adapter` 是唯一允许导入该 package 的模块。Runtime Server、SQLite/D1 Store、
Provider Loader、Web Console、Credential Store、Runtime token 和 global alias 均不进入 Connection
部署产物。ProviderRelease 发布前仍需生成实际 package SBOM、third-party notice、许可证兼容性报告
与漏洞报告，并取得 Legal 和 Security 签收。
