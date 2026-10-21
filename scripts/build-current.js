#!/usr/bin/env node
/**
 * 根据当前操作系统和 CPU 架构分发到对应平台构建脚本。
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const TARGET_SCRIPT = (() => {
  if (process.platform === "win32") return "build:win-x64";
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "build:mac-arm64" : "build:mac-x64";
  }
  if (process.platform === "linux") {
    return process.arch === "arm64" ? "build:linux-arm64" : "build:linux-x64";
  }
  return null;
})();

if (!TARGET_SCRIPT) {
  console.error(`[x] Unsupported platform: ${process.platform}-${process.arch}`);
  process.exit(1);
}

console.log(`[build] current platform ${process.platform}-${process.arch} -> npm run ${TARGET_SCRIPT}`);

// Windows 新版 Node 无法在 shell:false 下执行 npm.cmd（EINVAL）。
// 直接运行 npm 的 JS 入口，同时正确处理安装路径中的空格。
const npmCli = process.env.npm_execpath ||
  path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
if (!fs.existsSync(npmCli)) {
  console.error("[x] 找不到 npm CLI，请通过 npm run build 启动构建。");
  process.exit(1);
}
const result = spawnSync(process.execPath, [npmCli, "run", TARGET_SCRIPT], {
  stdio: "inherit",
  shell: false,
});

if (result.error) {
  console.error(`[x] Failed to run npm: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
