const fs = require("node:fs");
const path = require("node:path");

function isFile(filePath) {
  try { return fs.statSync(filePath).isFile(); } catch { return false; }
}

/** 按上游实际启动路径检查 CLI，不改动同包发布的运行时布局。 */
function resolveUpstreamCodex(platform, resourcesDir, binName) {
  const bundledDir = path.join(resourcesDir, "codex-cli");
  const executable = platform.startsWith("mac-") && fs.existsSync(bundledDir)
    ? path.join(bundledDir, "CodexCLI.app", "Contents", "MacOS", "codex")
    : path.join(resourcesDir, binName);
  if (!isFile(executable)) {
    throw new Error(`Upstream ${binName} not found for ${platform}: ${executable}`);
  }
  return executable;
}

/**
 * 新版平台包使用 bin/ 与 codex-path/；旧版使用 codex/ 与 path/。
 * Linux 桌面端仍从 Resources 根目录启动 CLI，辅助程序必须一起替换。
 */
function installLinuxCodexResources(vendorRoot, resourcesDir) {
  const modern = fs.existsSync(path.join(vendorRoot, "bin"));
  const executableDir = path.join(vendorRoot, modern ? "bin" : "codex");
  const files = new Map([
    ["codex", path.join(executableDir, "codex")],
    ["rg", path.join(vendorRoot, modern ? "codex-path" : "path", "rg")],
  ]);
  const host = path.join(executableDir, "codex-code-mode-host");
  if (modern || isFile(host) || isFile(path.join(resourcesDir, "codex-code-mode-host"))) {
    files.set("codex-code-mode-host", host);
  }
  const extraResources = path.join(vendorRoot, "codex-resources");
  const required = [...files.values()];
  if (modern) required.push(path.join(extraResources, "bwrap"));

  // 先验证整组文件，避免失败后留下半套 Linux / macOS 混合资源。
  for (const source of required) {
    if (!isFile(source)) throw new Error(`Linux CLI resource not found: ${source}`);
  }
  fs.mkdirSync(resourcesDir, { recursive: true });
  for (const [name, source] of files) {
    const destination = path.join(resourcesDir, name);
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, 0o755);
  }

  const destinationResources = path.join(resourcesDir, "codex-resources");
  fs.rmSync(destinationResources, { recursive: true, force: true });
  if (fs.existsSync(extraResources)) {
    fs.cpSync(extraResources, destinationResources, { recursive: true });
    const bwrap = path.join(destinationResources, "bwrap");
    if (isFile(bwrap)) fs.chmodSync(bwrap, 0o755);
  }
  // macOS 的 CLI bundle 不能继续进入 Linux 安装包。
  fs.rmSync(path.join(resourcesDir, "codex-cli"), { recursive: true, force: true });
  return [...files.keys()];
}

module.exports = { resolveUpstreamCodex, installLinuxCodexResources };
