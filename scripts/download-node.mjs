#!/usr/bin/env node
/**
 * 下载内置 Node 运行时，作为 Tauri sidecar 放到 src-tauri/binaries/
 *
 * sidecar 命名规则（Tauri externalBin 需要目标三元组后缀）：
 *   node-<target-triple>     （Windows 下为 node-<target-triple>.exe）
 *
 * 默认 Node 版本 v22.14.0，可用环境变量 LIBRETV_NODE_VERSION 覆盖。
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const binDir = path.join(root, "src-tauri", "binaries");

const NODE_VERSION = process.env.LIBRETV_NODE_VERSION || "v22.14.0";

const PLAN = {
  // platform + arch -> { triple, file, inner }
  "linux-x64": {
    triple: "x86_64-unknown-linux-gnu",
    file: `node-${NODE_VERSION}-linux-x64.tar.xz`,
    inner: `node-${NODE_VERSION}-linux-x64/bin/node`,
  },
  "linux-arm64": {
    triple: "aarch64-unknown-linux-gnu",
    file: `node-${NODE_VERSION}-linux-arm64.tar.xz`,
    inner: `node-${NODE_VERSION}-linux-arm64/bin/node`,
  },
  "darwin-x64": {
    triple: "x86_64-apple-darwin",
    file: `node-${NODE_VERSION}-darwin-x64.tar.gz`,
    inner: `node-${NODE_VERSION}-darwin-x64/bin/node`,
  },
  "darwin-arm64": {
    triple: "aarch64-apple-darwin",
    file: `node-${NODE_VERSION}-darwin-arm64.tar.gz`,
    inner: `node-${NODE_VERSION}-darwin-arm64/bin/node`,
  },
  "win32-x64": {
    triple: "x86_64-pc-windows-msvc",
    file: `node-${NODE_VERSION}-win-x64.zip`,
    inner: `node-${NODE_VERSION}-win-x64/node.exe`,
  },
  "win32-arm64": {
    triple: "aarch64-pc-windows-msvc",
    file: `node-${NODE_VERSION}-win-arm64.zip`,
    inner: `node-${NODE_VERSION}-win-arm64/node.exe`,
  },
};

const key = `${process.platform}-${process.arch}`;
const plan = PLAN[key];
if (!plan) {
  console.error(`✘ 不支持的平台: ${key}`);
  process.exit(1);
}

const destName =
  process.platform === "win32"
    ? `libretv-node-${plan.triple}.exe`
    : `libretv-node-${plan.triple}`;
const dest = path.join(binDir, destName);

if (fs.existsSync(dest) && fs.statSync(dest).size > 10_000_000) {
  console.log(`✔ sidecar 已存在，跳过: ${destName}`);
  process.exit(0);
}

fs.mkdirSync(binDir, { recursive: true });
const url = `https://nodejs.org/dist/${NODE_VERSION}/${plan.file}`;
const tmp = path.join(os.tmpdir(), plan.file);
const work = path.join(os.tmpdir(), `libretv-node-${plan.triple}`);

console.log(`[1/3] 下载 Node ${NODE_VERSION} (${plan.file})`);
execSync(`curl -fL --retry 3 -o "${tmp}" "${url}"`, { stdio: "inherit" });

console.log("[2/3] 解压");
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
execSync(`tar -xf "${tmp}" -C "${work}"`, { stdio: "inherit" });

console.log(`[3/3] 安装 sidecar: ${destName}`);
fs.copyFileSync(path.join(work, plan.inner), dest);
fs.chmodSync(dest, 0o755);
console.log(`✔ Node sidecar 就绪（${(fs.statSync(dest).size / 1024 / 1024).toFixed(0)} MB）`);
