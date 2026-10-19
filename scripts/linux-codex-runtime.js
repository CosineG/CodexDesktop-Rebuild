const fs = require("fs");
const path = require("path");

const LINUX_TARGETS = {
  "linux-x64": { triple: "x86_64-unknown-linux-musl", machine: 62 },
  "linux-arm64": { triple: "aarch64-unknown-linux-musl", machine: 183 },
};

function assertLinuxExecutable(file, platform) {
  const target = LINUX_TARGETS[platform];
  if (!target) throw new Error(`Unsupported Linux platform: ${platform}`);
  const header = Buffer.alloc(20);
  const fd = fs.openSync(file, "r");
  try {
    if (fs.readSync(fd, header, 0, header.length, 0) !== header.length ||
        !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
        header[4] !== 2 || header[5] !== 1) {
      throw new Error(`Not a Linux ELF64 executable: ${file}`);
    }
    if (header.readUInt16LE(18) !== target.machine) {
      throw new Error(`Linux executable architecture mismatch for ${platform}: ${file}`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function packagePath(root, relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) {
    throw new Error(`Invalid Codex package path: ${relative}`);
  }
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) {
    throw new Error(`Codex package path escapes its root: ${relative}`);
  }
  return resolved;
}

function inspectLinuxRuntime(vendorRoot, platform) {
  const target = LINUX_TARGETS[platform];
  if (!target) throw new Error(`Unsupported Linux platform: ${platform}`);
  const manifestPath = path.join(vendorRoot, "codex-package.json");
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;
  if (manifest && (manifest.layoutVersion !== 1 || manifest.target !== target.triple)) {
    throw new Error(`Unsupported Codex package layout or target for ${platform}: ${manifestPath}`);
  }
  const codex = manifest ? packagePath(vendorRoot, manifest.entrypoint) : path.join(vendorRoot, "codex", "codex");
  const host = path.join(path.dirname(codex), "codex-code-mode-host");
  const pathDir = manifest ? packagePath(vendorRoot, manifest.pathDir) : path.join(vendorRoot, "path");
  const resourcesDir = manifest ? packagePath(vendorRoot, manifest.resourcesDir) : path.join(vendorRoot, "codex-resources");
  const rg = path.join(pathDir, "rg");
  for (const file of [codex, host, rg]) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`Missing Linux runtime executable: ${file}`);
    assertLinuxExecutable(file, platform);
  }
  // Package-layout CLIs resolve bundled helpers via the manifest, not PATH.
  if (manifest && !fs.existsSync(resourcesDir)) throw new Error(`Missing Linux runtime resources: ${resourcesDir}`);
  for (const relative of ["bwrap", "zsh/bin/zsh"]) {
    const file = path.join(resourcesDir, relative);
    if (fs.existsSync(file)) assertLinuxExecutable(file, platform);
  }
  return { manifest, codex, host, rg, resourcesDir };
}

function copyRuntimeTree(source, destination) {
  fs.cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
}

function stageLinuxRuntime(vendorRoot, destination, platform) {
  const runtime = inspectLinuxRuntime(vendorRoot, platform);
  fs.mkdirSync(destination, { recursive: true });
  if (runtime.manifest) {
    copyRuntimeTree(vendorRoot, destination);
    // Desktop still resolves Resources/codex and Resources/rg. Relative links
    // keep the actual executable in bin/ so native package discovery works.
    for (const [name, source] of [["codex", runtime.codex], ["codex-code-mode-host", runtime.host], ["rg", runtime.rg]]) {
      const relative = path.relative(vendorRoot, source).split(path.sep).join("/");
      if (relative !== name) fs.symlinkSync(relative, path.join(destination, name), "file");
    }
  } else {
    for (const [name, source] of [["codex", runtime.codex], ["codex-code-mode-host", runtime.host], ["rg", runtime.rg]]) {
      fs.copyFileSync(source, path.join(destination, name));
    }
    if (fs.existsSync(runtime.resourcesDir)) copyRuntimeTree(runtime.resourcesDir, path.join(destination, "codex-resources"));
  }
  for (const name of ["codex", "codex-code-mode-host", "rg"]) fs.chmodSync(path.join(destination, name), 0o755);
  return runtime;
}

function assertPackagedLinuxRuntime(resourcesDir, platform) {
  const manifestPath = path.join(resourcesDir, "codex-package.json");
  if (fs.existsSync(manifestPath)) {
    const runtime = inspectLinuxRuntime(resourcesDir, platform);
    if (fs.realpathSync(path.join(resourcesDir, "codex")) !== fs.realpathSync(runtime.codex)) {
      throw new Error(`Packaged Codex launcher does not resolve to the package entrypoint: ${resourcesDir}`);
    }
  }
  for (const name of ["codex", "codex-code-mode-host", "rg"]) assertLinuxExecutable(path.join(resourcesDir, name), platform);
}

module.exports = { assertPackagedLinuxRuntime, copyRuntimeTree, stageLinuxRuntime };
