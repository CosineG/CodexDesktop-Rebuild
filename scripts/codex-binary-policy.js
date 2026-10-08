const fs = require("fs");
const path = require("path");

const CODEX_BINARY_SOURCE = new Map([
  ["mac-arm64", "upstream"],
  ["mac-x64", "upstream"],
  ["win", "upstream"],
  ["linux-x64", "cometix"],
  ["linux-arm64", "cometix"],
]);
const COMETIX_PLATFORM_TAG = new Map([
  ["linux-x64", "linux-x64"],
  ["linux-arm64", "linux-arm64"],
]);

/**
 * 桌面端 CLI 必须与同一安装包内的 app-server、code-mode host 保持协议一致。
 * Linux 没有可复用的上游原生资源，才使用对应架构的 @cometix/codex。
 */
function getCodexBinarySource(platform) {
  const source = CODEX_BINARY_SOURCE.get(platform);
  if (!source) throw new Error(`Unsupported Codex binary platform: ${platform}`);
  return source;
}

function findUpstreamCodex(platform, resourcesDir, binName = platform === "win" ? "codex.exe" : "codex") {
  // 26.1002 的 macOS CLI 改为独立 app bundle；与上游运行时使用同一路径。
  const candidates = platform === "mac-arm64" || platform === "mac-x64"
    ? [path.join(resourcesDir, "codex-cli", "CodexCLI.app", "Contents", "MacOS", binName)]
    : [];
  candidates.push(path.join(resourcesDir, binName));

  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

/**
 * 平台包可能晚于主包发布，必须采用已发布的架构 dist-tag，不能拼接 latest。
 */
function getCometixCodexPackageSpec(platform, distTags) {
  const tag = COMETIX_PLATFORM_TAG.get(platform);
  if (!tag) throw new Error(`Unsupported @cometix/codex platform: ${platform}`);

  const version = distTags?.[tag];
  if (!version) throw new Error(`Missing @cometix/codex dist-tag: ${tag}`);
  return `@cometix/codex@${version}`;
}

module.exports = { findUpstreamCodex, getCodexBinarySource, getCometixCodexPackageSpec };
