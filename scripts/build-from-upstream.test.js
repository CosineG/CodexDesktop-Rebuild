const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  assertWindowsPortableRuntime,
  createDmg,
  ensureWindowsPortableLauncher,
  isRetryableHdiutilError,
  keepUpstreamCodex,
  overlayPatchedExternalResources,
  patchWindowsAsarIntegrity,
} = require("./build-from-upstream");
const {
  getCodexBinarySource,
  getCometixCodexPackageSpec,
} = require("./codex-binary-policy");

function createTemporaryOutput(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-dmg-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    dmgPath: path.join(directory, "Codex.dmg"),
  };
}

test("识别 hdiutil 的瞬态资源占用错误", () => {
  assert.equal(isRetryableHdiutilError({ stderr: Buffer.from("hdiutil: create failed - Resource busy") }), true);
  assert.equal(isRetryableHdiutilError(new Error("Resource temporarily unavailable")), true);
  assert.equal(isRetryableHdiutilError(new Error("No space left on device")), false);
});

test("DMG 创建遇到资源占用时清理残留并退避重试", (t) => {
  const { directory, dmgPath } = createTemporaryOutput(t);
  const delays = [];
  let calls = 0;

  createDmg(directory, dmgPath, {
    attempts: 3,
    retryDelayMs: 10,
    log: () => {},
    wait: (delay) => delays.push(delay),
    run: (command, args) => {
      calls++;
      assert.equal(command, "hdiutil");
      assert.equal(args.at(-1), dmgPath);
      assert.equal(fs.existsSync(dmgPath), false);
      if (calls < 3) {
        fs.writeFileSync(dmgPath, "partial");
        const error = new Error("Command failed");
        error.stderr = Buffer.from("hdiutil: create failed - Resource busy");
        throw error;
      }
      fs.writeFileSync(dmgPath, "complete");
    },
  });

  assert.equal(calls, 3);
  assert.deepEqual(delays, [10, 20]);
  assert.equal(fs.readFileSync(dmgPath, "utf8"), "complete");
});

test("DMG 创建遇到确定性错误时立即失败", (t) => {
  const { directory, dmgPath } = createTemporaryOutput(t);
  let calls = 0;

  assert.throws(
    () => createDmg(directory, dmgPath, {
      attempts: 3,
      log: () => {},
      wait: () => assert.fail("不应等待重试"),
      run: () => {
        calls++;
        throw new Error("No space left on device");
      },
    }),
    /No space left on device/
  );
  assert.equal(calls, 1);
});

test("Windows Owl runtime 修补 ChatGPT.exe 中的 ASAR 哈希", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-owl-integrity-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const resourcesDir = path.join(directory, "resources");
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.writeFileSync(path.join(directory, "owl-shell-runtime.json"), "{}");
  fs.writeFileSync(path.join(resourcesDir, "owl-electron-app.json"), "{}");

  const oldHash = "a".repeat(64);
  const newHash = "b".repeat(64);
  const chatGptExe = path.join(directory, "ChatGPT.exe");
  const codexExe = path.join(directory, "Codex.exe");
  fs.writeFileSync(chatGptExe, `prefix:${oldHash}:suffix`);
  fs.writeFileSync(codexExe, "launcher-without-integrity-hash");

  assert.equal(patchWindowsAsarIntegrity(directory, oldHash, newHash), chatGptExe);
  assert.equal(fs.readFileSync(chatGptExe, "utf8"), `prefix:${newHash}:suffix`);
  assert.equal(fs.readFileSync(codexExe, "utf8"), "launcher-without-integrity-hash");
});

test("Windows Owl 便携包使用真实 runtime 覆盖 MSIX 启动存根", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-owl-launcher-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const resourcesDir = path.join(directory, "resources");
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.writeFileSync(path.join(directory, "owl-shell-runtime.json"), "{}");
  fs.writeFileSync(path.join(resourcesDir, "owl-electron-app.json"), "{}");
  fs.writeFileSync(path.join(directory, "ChatGPT.exe"), "owl-runtime");
  fs.writeFileSync(path.join(directory, "Codex.exe"), "msix-stub");

  assert.equal(
    ensureWindowsPortableLauncher(directory),
    path.join(directory, "Codex.exe"),
  );
  assert.equal(fs.readFileSync(path.join(directory, "Codex.exe"), "utf8"), "owl-runtime");
});

test("Windows Owl 便携构建拒绝依赖 MSIX 身份的清单", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-owl-manifest-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const manifestPath = path.join(directory, "package.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ codexWindowsAppContainedCore: "1" }));
  assert.throws(() => assertWindowsPortableRuntime(directory), /MSIX package identity/);

  fs.writeFileSync(manifestPath, JSON.stringify({ codexWindowsAppContainedCore: "0" }));
  assert.equal(assertWindowsPortableRuntime(directory).codexWindowsAppContainedCore, "0");
});

test("macOS 和 Windows 保留上游 CLI，Linux 使用平台替换包", () => {
  assert.equal(getCodexBinarySource("mac-arm64"), "upstream");
  assert.equal(getCodexBinarySource("mac-x64"), "upstream");
  assert.equal(getCodexBinarySource("win"), "upstream");
  assert.equal(getCodexBinarySource("linux-x64"), "cometix");
  assert.equal(getCodexBinarySource("linux-arm64"), "cometix");
  assert.throws(() => getCodexBinarySource("freebsd-x64"), /Unsupported Codex binary platform/);
});

test("Cometix 平台包使用架构 dist-tag 而不是拼接主包版本", () => {
  const distTags = {
    latest: "0.144.4-cometix",
    "linux-x64": "0.144.3-cometix-linux-x64",
    "linux-arm64": "0.144.4-cometix-linux-arm64",
  };

  assert.equal(
    getCometixCodexPackageSpec("linux-x64", distTags),
    "@cometix/codex@0.144.3-cometix-linux-x64",
  );
  assert.equal(
    getCometixCodexPackageSpec("linux-arm64", distTags),
    "@cometix/codex@0.144.4-cometix-linux-arm64",
  );
  assert.throws(
    () => getCometixCodexPackageSpec("linux-x64", { latest: distTags.latest }),
    /Missing @cometix\/codex dist-tag/,
  );
});

test("保留上游 CLI 时不会改写二进制", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cli-policy-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const codexPath = path.join(directory, "codex");
  const original = Buffer.from("upstream-cli-same-release");
  fs.writeFileSync(codexPath, original);

  assert.equal(keepUpstreamCodex("mac-arm64", directory, "codex"), codexPath);
  assert.deepEqual(fs.readFileSync(codexPath), original);
  assert.throws(
    () => keepUpstreamCodex("linux-x64", directory, "codex"),
    /cannot use a replacement CLI/,
  );
});

test("macOS 26.1002 从 CodexCLI.app 保留 CLI，优先于旧路径", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-nested-cli-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const codexPath = path.join(directory, "codex-cli", "CodexCLI.app", "Contents", "MacOS", "codex");
  fs.mkdirSync(path.dirname(codexPath), { recursive: true });
  const original = Buffer.from("upstream-26.1002-cli");
  fs.writeFileSync(codexPath, original);

  for (const platform of ["mac-arm64", "mac-x64"]) {
    assert.equal(keepUpstreamCodex(platform, directory, "codex"), codexPath);
  }
  assert.deepEqual(fs.readFileSync(codexPath), original);
  assert.equal(fs.existsSync(path.join(directory, "codex")), false);

  // 新版应用本身解析嵌套路径，遗留的平铺文件不能抢占它。
  fs.writeFileSync(path.join(directory, "codex"), "stale-flat-cli");
  assert.equal(keepUpstreamCodex("mac-arm64", directory, "codex"), codexPath);
  assert.deepEqual(fs.readFileSync(codexPath), original);
});

test("直打包流程覆盖 ASAR 外的插件与 CUA 补丁", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-external-overlay-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const platformDir = path.join(directory, "platform");
  const resourcesDir = path.join(directory, "resources");
  for (const relativePath of [
    path.join("plugins", "browser-service.mjs"),
    path.join("cua_node", "runtime.js"),
  ]) {
    fs.mkdirSync(path.dirname(path.join(platformDir, relativePath)), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(resourcesDir, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(platformDir, relativePath), `patched:${relativePath}`);
    fs.writeFileSync(path.join(resourcesDir, relativePath), `upstream:${relativePath}`);
  }
  fs.writeFileSync(path.join(resourcesDir, "unrelated.txt"), "keep");

  assert.equal(overlayPatchedExternalResources(platformDir, resourcesDir), 2);
  assert.equal(
    fs.readFileSync(path.join(resourcesDir, "plugins", "browser-service.mjs"), "utf8"),
    `patched:${path.join("plugins", "browser-service.mjs")}`,
  );
  assert.equal(
    fs.readFileSync(path.join(resourcesDir, "cua_node", "runtime.js"), "utf8"),
    `patched:${path.join("cua_node", "runtime.js")}`,
  );
  assert.equal(fs.readFileSync(path.join(resourcesDir, "unrelated.txt"), "utf8"), "keep");
});

test("外置插件覆盖可替换上游只读配置并保留文件权限", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-readonly-overlay-test-"));
  const platformDir = path.join(directory, "platform");
  const resourcesDir = path.join(directory, "resources");
  const relative = path.join("plugins", "openai-bundled", "plugins", "unified-computer-use", ".mcp.json");
  const source = path.join(platformDir, relative);
  const destination = path.join(resourcesDir, relative);
  t.after(() => {
    // Windows cannot remove files carrying the read-only attribute.
    for (const file of [source, destination]) {
      if (fs.existsSync(file)) fs.chmodSync(file, 0o644);
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const patched = JSON.stringify({ mcpServers: { browser: { command: "patched-runtime" } } });
  fs.writeFileSync(source, patched);
  fs.writeFileSync(destination, JSON.stringify({ mcpServers: {} }));
  // macOS 26.1007.21159 arm64 ZIP marks this file as 0444; ditto keeps it.
  fs.chmodSync(source, 0o444);
  fs.chmodSync(destination, 0o444);
  const originalMode = fs.statSync(destination).mode & 0o777;

  assert.equal(overlayPatchedExternalResources(platformDir, resourcesDir), 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(destination, "utf8")), JSON.parse(patched));
  assert.equal(fs.statSync(destination).mode & 0o777, originalMode);
  assert.equal(fs.readFileSync(source, "utf8"), patched);
  assert.equal(fs.statSync(source).mode & 0o200, 0);
});
