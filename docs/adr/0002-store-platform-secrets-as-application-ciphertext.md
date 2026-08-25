# Platform Secret 使用项目内置密文存储

Agent Platform 在 Platform DB 中保存随机 DEK 加密的版本化 AEAD Secret 密文，并用部署提供的版本化公钥封装 DEK，不强制依赖外部 KMS 或 Secret Store 服务。初始密文格式固定为 CSPRNG 256-bit DEK、AES-256-GCM、唯一 96-bit nonce、128-bit tag、绑定 Secret/Owner/Agent/版本的长度前缀 canonical AAD，以及至少 3072-bit RSA-OAEP-SHA-256 DEK 封装。`platform-api` 只持有加密公钥，`platform-worker` 独占解密私钥；Secret 通过带 generation/fence 的可恢复两阶段协议确认 Workload 已使用候选版本后才激活。密钥轮换在退役旧私钥前重新加密或封装历史记录，从而避免 API 被攻破后批量解密历史 Secret，也不让私钥进入仓库、数据库、Agent Pod、日志或用户接口。
