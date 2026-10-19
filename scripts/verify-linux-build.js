#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { assertPackagedLinuxRuntime } = require("./linux-codex-runtime");

function verifyLinuxBuild(platform) {
  const arch = platform?.replace(/^linux-/, "");
  if (!["x64", "arm64"].includes(arch)) throw new Error("Usage: verify-linux-build.js <linux-x64|linux-arm64>");
  if (process.platform !== "linux" || process.arch !== arch) {
    throw new Error(`Linux runtime smoke tests require a native ${platform} host`);
  }
  const resources = path.resolve(__dirname, "..", "out", `Codex-linux-${arch}`, "resources");
  assertPackagedLinuxRuntime(resources, platform);
  for (const [name, args] of [
    ["codex", ["--version"]],
    ["codex", ["app-server", "--help"]],
    ["codex-code-mode-host", ["--help"]],
    ["rg", ["--version"]],
  ]) {
    const output = execFileSync(path.join(resources, name), args, {
      encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
    });
    console.log(`[ok] packaged ${name} ${args.join(" ")}: ${output.trim().split("\n")[0]}`);
  }
  const manifestPath = path.join(resources, "codex-package.json");
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    console.log(`[ok] packaged CLI ${manifest.version}, target ${manifest.target}, layout ${manifest.layoutVersion}`);
  }
}

if (require.main === module) {
  try { verifyLinuxBuild(process.argv[2]); } catch (error) {
    console.error(`[x] ${error.message}`);
    if (error.stderr) console.error(String(error.stderr));
    process.exitCode = 1;
  }
}

module.exports = { verifyLinuxBuild };
