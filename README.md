# LibreTV Desktop

把 [LibreTV](https://github.com/LibreSpark/LibreTV)（Next.js 15 影视聚合服务）打包成 **原生桌面应用**（Rust / Tauri v2）。

- 启动即用：应用内自带 Next.js standalone 服务 + Node 运行时（sidecar），无需安装 Node / 无需 Docker
- 原生窗口：Tauri WebView 加载 `http://127.0.0.1:<端口>`，退出应用自动回收内置服务进程
- 数据都在本机：播放进度/历史存 IndexedDB，配置存应用配置目录
- 三平台出包：Windows（.msi/.exe）、macOS（.dmg/.app）、Linux（.deb/.AppImage）

## 目录结构

```
libretv-desktop/
├── src-tauri/            # Rust 桌面壳
│   ├── src/lib.rs        # 拉起内置服务 → 等待就绪 → 开窗口 → 退出回收
│   ├── tauri.conf.json   # externalBin: node sidecar；resources: server/
│   └── binaries/         # 各平台 Node 运行时（download-node.mjs 生成）
├── server/               # LibreTV standalone 服务（prepare-server.mjs 生成）
├── scripts/
│   ├── prepare-server.mjs  # 克隆+构建 LibreTV → 组装自包含 server/
│   └── download-node.mjs   # 下载当前平台 Node 作为 sidecar
├── ui/index.html         # 启动占位页
└── .github/workflows/build.yml  # GitHub Actions 三平台一键出包
```

## 本机构建（三条命令）

前置：Node.js 18.18+、Rust（https://rustup.rs）。

```bash
git clone <本仓库> && cd libretv-desktop
npm install                                   # 安装 tauri CLI
npm run prepare:server                        # 构建内置服务（首次约 5 分钟）
npm run prepare:node                          # 下载本平台 Node sidecar
npm run tauri build                           # 出安装包
```

安装包输出：`src-tauri/target/release/bundle/`
- Windows: `LibreTV_2.x.x_x64-setup.exe` / `.msi`
- macOS: `LibreTV_2.x.x_aarch64.dmg`（x64 用 `x86_64-apple-darwin`）
- Linux: `LibreTV_2.x.x_amd64.deb` / `.AppImage`

> Linux 额外需要系统库：`sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf`

## 不想装 Rust？用 GitHub Actions 一键出包

1. 把这个仓库推到你的 GitHub（公开或私有均可）
2. 打开 **Actions** 页 → **Build LibreTV Desktop** → **Run workflow**
3. 跑完后在任务页 **Artifacts** 下载对应平台安装包

工作流已在 `.github/workflows/build.yml`：自动装 Rust/系统库、构建内置服务、下载 Node sidecar、出包并上传四套（Linux x64 / Windows x64 / macOS x64 / macOS arm64）。

## 使用说明

- 首次启动自动生成配置文件（Linux: `~/.config/io.github.libretv.desktop/config.json`，Windows: `%APPDATA%\io.github.libretv.desktop\config.json`，macOS: `~/Library/Application Support/io.github.libretv.desktop/config.json`）：

```json
{
  "password": "libretv-local",   // 访问密码，改完重启应用
  "port": 0                       // 0 = 每次自动选空闲端口
}
```

- 数据源：应用内 设置 → 源管理 添加采集站 / M3U / 订阅，与网页版完全一致
- 端口每次启动自动挑选空闲端口，避免与其他服务冲突
- macOS 未签名：首次打开需右键 → 打开（或 `xattr -cr /Applications/LibreTV.app`）

## 技术要点

- **内置服务**：`prepare-server.mjs` 以 `DOCKER_BUILD=1` 构建 Next.js standalone 产物（自包含 node_modules + server.js），并把 `public/`、`.next/static/` 并入 `server/`
- **Node 运行时**：`download-node.mjs` 下载官方 Node 二进制，按 Tauri sidecar 规则命名 `libretv-node-<target-triple>`（加前缀避免与系统 `node` 冲突），只打进当前平台那个（externalBin 机制）
- **进程管理**：Rust 侧 `sidecar.spawn()` 拉起服务 → 轮询 `/api/status` 就绪后建窗口 → `RunEvent::ExitRequested/Exit` + ctrlc 信号处理（SIGTERM/SIGINT/SIGHUP）三路回收
- **资源定位**：打包后 `../server` 资源映射为 `<resource_dir>/_up_/server`，Rust 侧多候选路径探测，兼容 deb/AppImage/开发三种布局
- **构建工作区**：LibreTV 源码构建放在项目目录外（系统临时目录），避免 Next standalone 把工作区递归复制进产物
