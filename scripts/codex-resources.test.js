const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { keepUpstreamCodex } = require("./build-from-upstream");
const { installLinuxCodexResources } = require("./codex-resources");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-resources-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, content = relative) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  return { root, write };
}

for (const platform of ["mac-arm64", "mac-x64"]) {
  test(`${platform} 校验嵌套 CLI 的真实入口并保留原始布局`, (t) => {
    const { root, write } = fixture(t);
    const binary = write("codex-cli/CodexCLI.app/Contents/MacOS/codex", "upstream-cli");
    const launcher = write("codex-cli/bin/codex", "launcher");
    assert.equal(keepUpstreamCodex(platform, root, "codex"), binary);
    assert.equal(fs.existsSync(path.join(root, "codex")), false);
    assert.equal(fs.readFileSync(binary, "utf8"), "upstream-cli");
    assert.equal(fs.readFileSync(launcher, "utf8"), "launcher");
  });
}

test("macOS 新布局缺少真实 CLI 时不能被启动脚本或旧副本掩盖", (t) => {
  const { root, write } = fixture(t);
  write("codex-cli/bin/codex", "launcher");
  write("codex", "stale-cli");
  assert.throws(() => keepUpstreamCodex("mac-arm64", root, "codex"), /Upstream codex not found/);
});

test("Linux 新平台包同时安装 CLI、搜索、代码执行及沙箱资源", (t) => {
  const { root, write } = fixture(t);
  write("vendor/bin/codex", "linux-cli");
  write("vendor/bin/codex-code-mode-host", "linux-code-host");
  write("vendor/codex-path/rg", "linux-rg");
  write("vendor/codex-resources/bwrap", "linux-sandbox");
  write("resources/codex-cli/CodexCLI.app/Contents/MacOS/codex", "mac-cli");
  write("resources/codex-code-mode-host", "mac-code-host");
  write("resources/codex-resources/voice/mac.dylib", "mac-voice");
  write("resources/plugins/patched.mjs", "patched");
  const resources = path.join(root, "resources");
  installLinuxCodexResources(path.join(root, "vendor"), resources);
  for (const [file, content] of [
    ["codex", "linux-cli"], ["rg", "linux-rg"],
    ["codex-code-mode-host", "linux-code-host"], ["codex-resources/bwrap", "linux-sandbox"],
  ]) {
    assert.equal(fs.readFileSync(path.join(resources, file), "utf8"), content);
    if (process.platform !== "win32") assert.equal(fs.statSync(path.join(resources, file)).mode & 0o111, 0o111);
  }
  assert.equal(fs.existsSync(path.join(resources, "codex-cli")), false);
  assert.equal(fs.existsSync(path.join(resources, "codex-resources/voice")), false);
  assert.equal(fs.readFileSync(path.join(resources, "plugins/patched.mjs"), "utf8"), "patched");
});

test("Linux 兼容旧版 codex/ 与 path/ 平台包", (t) => {
  const { root, write } = fixture(t);
  write("vendor/codex/codex", "legacy-cli");
  write("vendor/path/rg", "legacy-rg");
  const resources = path.join(root, "resources");
  installLinuxCodexResources(path.join(root, "vendor"), resources);
  assert.equal(fs.readFileSync(path.join(resources, "codex"), "utf8"), "legacy-cli");
  assert.equal(fs.readFileSync(path.join(resources, "rg"), "utf8"), "legacy-rg");
});

for (const missing of ["bin/codex", "bin/codex-code-mode-host", "codex-path/rg", "codex-resources/bwrap"]) {
  test(`Linux 包缺少 ${missing} 时在改写资源前失败`, (t) => {
    const { root, write } = fixture(t);
    for (const file of ["bin/codex", "bin/codex-code-mode-host", "codex-path/rg", "codex-resources/bwrap"]) {
      if (file !== missing) write(`vendor/${file}`, "linux");
    }
    write("resources/codex", "original");
    write("resources/rg", "original-rg");
    const resources = path.join(root, "resources");
    assert.throws(() => installLinuxCodexResources(path.join(root, "vendor"), resources), /Linux CLI resource not found/);
    assert.equal(fs.readFileSync(path.join(resources, "codex"), "utf8"), "original");
    assert.equal(fs.readFileSync(path.join(resources, "rg"), "utf8"), "original-rg");
  });
}
