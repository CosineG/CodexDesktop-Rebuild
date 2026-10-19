const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function write(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function elf(machine) {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  bytes.writeUInt16LE(machine, 18);
  return bytes;
}

function fixture(t, arch = "x64", modern = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-prepare-test-"));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.cpSync(path.join(__dirname), path.join(root, "scripts"), {
    recursive: true,
    filter: (file) => !file.endsWith(".test.js"),
  });
  const triple = arch === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl";
  const vendor = path.join(root, "node_modules/@cometix/codex/vendor", triple);
  const source = path.join(root, `src/mac-${arch}`);
  write(root, "package.json", JSON.stringify({ version: "1.0.0" }));
  write(source, "_asar/package.json", JSON.stringify({ version: "1.0.1", main: ".vite/build/early-bootstrap.js" }));
  write(source, "_asar/.vite/build/early-bootstrap.js", "console.log('upstream');");
  write(source, "codex", "macos-cli");
  write(source, "rg", "macos-rg");
  write(source, "codex-cli/CodexCLI.app/Contents/MacOS/codex", "macos-nested-cli");
  write(source, "plugins/browser.js", "patched-browser");
  fs.mkdirSync(path.join(root, "node_modules/@electron"), { recursive: true });
  fs.symlinkSync(path.resolve(__dirname, "../node_modules/@electron/asar"), path.join(root, "node_modules/@electron/asar"), "junction");
  const binary = elf(arch === "arm64" ? 183 : 62);
  write(vendor, modern ? "bin/codex" : "codex/codex", binary);
  write(vendor, modern ? "bin/codex-code-mode-host" : "codex/codex-code-mode-host", binary);
  write(vendor, modern ? "codex-path/rg" : "path/rg", binary);
  write(vendor, "codex-resources/bwrap", binary);
  if (modern) {
    write(vendor, "codex-resources/zsh/bin/zsh", binary);
    write(vendor, "codex-package.json", JSON.stringify({
      layoutVersion: 1, version: "0.159.1-cometix", target: triple,
      entrypoint: "bin/codex", pathDir: "codex-path", resourcesDir: "codex-resources",
    }));
  }
  return { root, source, vendor, binary, arch };
}

function prepare(f) {
  return spawnSync(process.execPath, [path.join(f.root, "scripts/prepare-src.js"), "--platform", `linux-${f.arch}`], {
    encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
  });
}

async function packageResources(f) {
  fs.copyFileSync(path.resolve(__dirname, "../forge.config.js"), path.join(f.root, "forge.config.js"));
  fs.symlinkSync(path.resolve(__dirname, "../node_modules/@electron/fuses"), path.join(f.root, "node_modules/@electron/fuses"), "junction");
  const buildPath = path.join(f.root, "out/resources/app");
  fs.mkdirSync(buildPath, { recursive: true });
  const config = require(path.join(f.root, "forge.config.js"));
  await config.hooks.packageAfterCopy(config, buildPath, "42.0.1", "linux", f.arch);
  return path.dirname(buildPath);
}

test("Linux preparation and Forge preserve the actual 0.159.1 package layout and complete runtime", async (t) => {
  const f = fixture(t);
  const result = prepare(f);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const runtime = path.join(f.root, "src/linux-x64/codex-runtime");
  for (const relative of ["bin/codex", "bin/codex-code-mode-host", "codex-path/rg", "codex-resources/bwrap", "codex-resources/zsh/bin/zsh"]) {
    assert.deepEqual(fs.readFileSync(path.join(runtime, relative)), f.binary, relative);
  }
  assert.equal(fs.realpathSync(path.join(runtime, "codex")), fs.realpathSync(path.join(runtime, "bin/codex")));
  assert.equal(fs.readFileSync(path.join(f.source, "codex"), "utf8"), "macos-cli");
  const resources = await packageResources(f);
  assert.deepEqual(fs.readFileSync(path.join(resources, "codex")), f.binary);
  assert.equal(fs.realpathSync(path.join(resources, "codex")), fs.realpathSync(path.join(resources, "bin/codex")));
  assert.deepEqual(fs.readFileSync(path.join(resources, "codex-resources/zsh/bin/zsh")), f.binary);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(resources, "codex-package.json"))), JSON.parse(fs.readFileSync(path.join(f.vendor, "codex-package.json"))));
  assert.equal(fs.existsSync(path.join(resources, "codex-cli")), false, "macOS CLI bundle must not enter Linux artifacts");
  assert.equal(fs.readFileSync(path.join(resources, "plugins/browser.js"), "utf8"), "patched-browser");
  if (process.platform !== "win32") assert.ok(fs.statSync(path.join(resources, "codex")).mode & 0o111);
});

test("Linux preparation and Forge still assemble legacy vendor packages", async (t) => {
  const f = fixture(t, "arm64", false);
  const result = prepare(f);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const runtime = path.join(f.root, "src/linux-arm64/codex-runtime");
  for (const relative of ["codex", "codex-code-mode-host", "rg", "codex-resources/bwrap"]) {
    assert.deepEqual(fs.readFileSync(path.join(runtime, relative)), f.binary, relative);
  }
  const resources = await packageResources(f);
  assert.deepEqual(fs.readFileSync(path.join(resources, "codex-code-mode-host")), f.binary);
  assert.deepEqual(fs.readFileSync(path.join(resources, "rg")), f.binary);
  assert.equal(fs.existsSync(path.join(resources, "codex-cli")), false);
});

test("Linux preparation refuses an incomplete or foreign-architecture CLI instead of keeping macOS binaries", (t) => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.vendor, "bin/codex-code-mode-host"));
  let result = prepare(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /codex-code-mode-host/);
  write(f.vendor, "bin/codex-code-mode-host", elf(183));
  result = prepare(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /architecture mismatch/);
  write(f.vendor, "bin/codex-code-mode-host", f.binary);
  fs.unlinkSync(path.join(f.vendor, "codex-path/rg"));
  result = prepare(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing Linux runtime executable:.*rg/);
});
