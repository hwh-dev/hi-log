# 发布与自动更新

hi-log 使用 Tauri 2 的构建与更新体系。本文档说明打包、签名与更新服务器部署。

## 1. 打包

```bash
npm run tauri build   # 构建 release + 平台安装包
```

产物目录:`src-tauri/target/release/bundle/`

| 平台 | 安装包 | 说明 |
| --- | --- | --- |
| Windows | NSIS(`.exe`)+ MSI(`.msi`) | tauri.conf.json `bundle.targets` 已配置 |
| Linux | deb / AppImage / rpm | 需在 Linux 构建机上执行 |
| macOS | dmg / app | 需在 macOS 构建机上执行 |

跨平台:推荐 GitHub Actions(tauri-apps/tauri-action),三平台矩阵构建。

## 2. 自动更新(tauri-plugin-updater)

更新链路:应用启动(及每 4 小时)向更新服务器请求 `latest.json`;有新版时提示用户安装。

### 2.1 生成签名密钥(一次性)

```bash
npx tauri signer generate -w ~/.tauri/hi-log.key
```

- 私钥 `~/.tauri/hi-log.key` **必须保密**,放入 CI secrets
- 公钥写入 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`
- Windows 更新包还需代码签名证书(可选但推荐);未签名时 Windows SmartScreen 会拦截

### 2.2 更新服务器

任一静态文件服务器(如 GitHub Releases / S3 / 自建 Nginx),放两个文件:

- `latest.json` — 版本清单(见下)
- 安装包 + `.sig` 签名文件(由 `npx tauri signer sign` 生成)

`latest.json` 示例:

```json
{
  "version": "0.2.0",
  "notes": "修复了…",
  "pub_date": "2026-08-02T10:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "dW50cnVzdGVk…（安装包 .sig 内容）",
      "url": "https://updates.example.com/hi-log_0.2.0_x64-setup.exe"
    }
  }
}
```

### 2.3 配置

`tauri.conf.json`:

```json
{
  "plugins": {
    "updater": {
      "pubkey": "（生成的公钥）",
      "endpoints": ["https://updates.example.com/latest.json"]
    }
  }
}
```

> 注意:未配置公钥时 updater 插件在运行时不可用(前端检查会静默失败),属于预期行为。

### 2.4 前端检查

`ui/src/App.tsx` 启动时调用 `@tauri-apps/plugin-updater` 的 `check()`,
发现新版本弹窗确认后 `downloadAndInstall()`(Windows 需重启生效)。
当前实现:启动 3 秒后静默检查,失败(未配置/无网络)不打扰用户。

## 3. 发布流程核对清单

1. `npm run tauri build` 三平台产物
2. `npx tauri signer sign -w ~/.tauri/hi-log.key <安装包>` 生成 `.sig`
3. 上传安装包 + `.sig` 到更新服务器
4. 更新 `latest.json`(version / url / signature / pub_date)
5. 本地验证:旧版本启动 → 检查到新版 → 安装
