#!/usr/bin/env node
/**
 * 构建 LibreTV 内置服务（Next.js standalone 自包含产物）并组装到 server/
 *
 * 重要：构建工作区必须放在本项目目录【之外】——否则 Next 的 standalone
 * 组装会把工作区整个递归复制进产物。
 *
 * - 默认从 GitHub 克隆 LibreTV 源码构建
 * - 可用环境变量 LIBRETV_SRC 指向本地已 clone 的源码目录（跳过克隆，复用依赖）
 *
 * 产物 server/ 结构（会被 tauri.conf.json 的 resources 打包进应用）：
 *   server.js + node_modules/ + .next/ + public/
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
// 工作区放项目外（系统临时目录），避免被 Next standalone 复制
const buildDir = path.join(os.tmpdir(), "libretv-desktop-build");
const srcDir = path.join(buildDir, "libretv-src");
const serverDir = path.join(root, "server");

const run = (cmd, opts = {}) =>
  execSync(cmd, { stdio: "inherit", ...opts });

// ---------- 1. 获取源码 ----------
if (process.env.LIBRETV_SRC) {
  const from = path.resolve(process.env.LIBRETV_SRC);
  console.log(`[1/4] 复用本地源码: ${from}`);
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });
  // 只复制必要文件，跳过 node_modules/.next/.git
  run(
    `cp -r "${from}/." "${srcDir}" 2>/dev/null; ` +
      `rm -rf "${srcDir}/node_modules" "${srcDir}/.next" "${srcDir}/.git" "${srcDir}/server.log" "${srcDir}/.env.local"`,
    { shell: true }
  );
} else {
  console.log("[1/4] 克隆 LibreTV 源码");
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });
  run(
    `git clone --depth 1 https://github.com/LibreSpark/LibreTV.git "${srcDir}"`
  );
}

// ---------- 2. 安装依赖（带重试，npm 偶发失败时自动重来一次） ----------
console.log("[2/4] 安装依赖");
const installDeps = () =>
  run(`cd "${srcDir}" && npm install --no-audit --no-fund`, { shell: true });
try {
  installDeps();
} catch {
  console.warn("npm install 首次失败，清空 node_modules 重试…");
  fs.rmSync(path.join(srcDir, "node_modules"), { recursive: true, force: true });
  installDeps();
}
if (!fs.existsSync(path.join(srcDir, "node_modules", ".bin", "next"))) {
  throw new Error("依赖安装后未找到 next 可执行文件");
}

// ---------- 3. 以 standalone 模式构建 ----------
console.log("[3/4] 构建 standalone 服务端");
run(`cd "${srcDir}" && DOCKER_BUILD=1 npm run build`, { shell: true });

// ---------- 4. 组装 server/ ----------
console.log("[4/4] 组装 server/");
fs.rmSync(serverDir, { recursive: true, force: true });
fs.mkdirSync(serverDir, { recursive: true });
const standalone = path.join(srcDir, ".next", "standalone");
if (!fs.existsSync(path.join(standalone, "server.js"))) {
  throw new Error(
    `standalone 产物缺少 server.js（${standalone}）——构建工作区不得位于本项目目录内`
  );
}
run(`cp -r "${standalone}/." "${serverDir}"`, { shell: true });

// public/ 与 .next/static/ 需手工并入（Next standalone 默认不包含）
if (fs.existsSync(path.join(srcDir, "public"))) {
  fs.mkdirSync(path.join(serverDir, "public"), { recursive: true });
  run(`cp -r "${path.join(srcDir, "public")}/." "${path.join(serverDir, "public")}"`, {
    shell: true,
  });
}
if (fs.existsSync(path.join(srcDir, ".next", "static"))) {
  fs.mkdirSync(path.join(serverDir, ".next", "static"), { recursive: true });
  run(
    `cp -r "${path.join(srcDir, ".next", "static")}/." "${path.join(serverDir, ".next", "static")}"`,
    { shell: true }
  );
}

// sharp 的 musl 变体（Alpine 专用）在 glibc 桌面系统无用，且会让 AppImage 打包器
// 误判需要 musl libc 而失败，统一剔除
run(
  `find "${serverDir}/node_modules/@img" -maxdepth 1 -iname '*musl*' -exec rm -rf {} + 2>/dev/null || true`,
  { shell: true }
);

const sizeMB = (fs.readdirSync(serverDir).reduce(
  (acc, name) => acc + fs.statSync(path.join(serverDir, name)).size,
  0
) / 1024 / 1024).toFixed(0);
console.log(`✔ server/ 就绪（约 ${sizeMB} MB）：${serverDir}`);
