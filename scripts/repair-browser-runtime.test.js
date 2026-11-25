const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { parse } = require("acorn");
const { RUNTIME_DIRS, assertNetworkPolicySupport, resolveServiceImplementation, planRepair, applyRepair } = require("./repair-browser-runtime");
const { ROUTING_FILES, patchSource } = require("./patch-windows-browser-routing");

const SERVICE = `class Preferences {
  async getNetworkPolicy() { return [await this.config.readRequirements(), await this.config.readAll()] }
}
class Client { attach(tab, policy) { return this.sendSessionRequest("attach", {tabId: tab, networkPolicy: policy}) } }
class CDP { async attachTab(tab) { return this.api.attach(tab, await this.readNetworkPolicy()) } }`;
const LAUNCHER = (current) => `export const revision = ${current ? 2 : 1};
export const bootstrap = () => import("./browser-service-core.mjs");`;
const SKILL = '---\nname: computer-use\ndescription: Control Windows apps\n---\n\n# Computer Use\n\n## Initialize\nconst { sky } = await import("@oai/sky");\n';
const COMPUTER = 'Use an app from inventory.\nlet app = await cua.getApp("Example App");\n';

// 与上游 26.1120 的实际布局保持一致：服务可能拆成启动器与核心，也可能只有客户端。
const LAYOUTS = {
  [RUNTIME_DIRS[0]]: ["browser-client.mjs", "browser-service.mjs", "browser-service-core.mjs",
    "browser-accessibility.wasm.br", "zxing_reader.wasm"],
  [RUNTIME_DIRS[1]]: ["browser-client.js", "browser-client.mjs"],
  [RUNTIME_DIRS[2]]: ["browser-client.mjs", "browser-service.mjs",
    "browser-accessibility.wasm.br", "zxing_reader.wasm"],
  [RUNTIME_DIRS[3]]: ["browser-client.mjs"],
};

/** 按文件名和目录生成可区分的上游/目标内容。 */
function runtimeContent(directory, name, current) {
  if (name === "browser-service.mjs" || name === "browser-service-core.mjs") {
    // 第一个入口是“瘦启动器 + 核心”，其他含服务的入口是单文件完整服务。
    if (directory === RUNTIME_DIRS[0] && name === "browser-service.mjs") return LAUNCHER(current);
    if (directory === RUNTIME_DIRS[0]) return current ? SERVICE : "export const legacy = true;";
    return current ? SERVICE : "export const legacy = true;";
  }
  if (name.endsWith(".mjs") || name.endsWith(".js")) return `export const revision = ${current ? 2 : 1};`;
  return Buffer.from(current ? [0, 2, 255] : [0, 1, 255]);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-repair-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const resourcesRoot = path.join(root, "resources");
  for (const directory of RUNTIME_DIRS) {
    for (const [base, current] of [[sourceRoot, true], [resourcesRoot, false]]) {
      fs.mkdirSync(path.join(base, directory), { recursive: true });
      for (const name of LAYOUTS[directory]) {
        fs.writeFileSync(path.join(base, directory, name), runtimeContent(directory, name, current));
      }
    }
  }
  for (const target of ROUTING_FILES) {
    const file = path.join(resourcesRoot, target.relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, target.kind === "skill" ? SKILL : COMPUTER);
  }
  fs.writeFileSync(path.join(resourcesRoot, "codex.exe"), "unchanged-cli");
  return { root, sourceRoot, resourcesRoot };
}

test("检查模式只读，应用时成套同步、保留备份且可重复执行", (t) => {
  const options = fixture(t);
  const before = planRepair(options);
  const output = execFileSync(process.execPath, [path.join(__dirname, "repair-browser-runtime.js"),
    "--source", options.sourceRoot, "--resources", options.resourcesRoot, "--check"], { encoding: "utf8" });
  assert.match(output, /require update/);
  for (const item of before) assert.deepEqual(fs.readFileSync(item.file), item.before);
  assert.equal(fs.existsSync(path.join(options.root, "browser-runtime-backups")), false);
  const backup = applyRepair(before, path.join(options.root, "backups"));
  const manifest = JSON.parse(fs.readFileSync(path.join(backup, "manifest.json")));
  assert.equal(manifest.length, before.length);
  for (const [index, item] of before.entries()) {
    assert.deepEqual(fs.readFileSync(item.file), item.data);
    assert.deepEqual(fs.readFileSync(path.join(backup, manifest[index].backup)), item.before);
  }
  assert.equal(fs.readFileSync(path.join(options.resourcesRoot, "codex.exe"), "utf8"), "unchanged-cli");
  assert.equal(planRepair(options).length, 0);
});

test("入口目录不含浏览器运行时文件时，全部预检失败且不产生写入", (t) => {
  const options = fixture(t);
  const before = planRepair(options);
  const empty = path.join(options.sourceRoot, RUNTIME_DIRS.at(-1));
  for (const name of fs.readdirSync(empty)) fs.unlinkSync(path.join(empty, name));
  assert.throws(() => planRepair(options), /未发现可同步的浏览器运行时文件/);
  for (const item of before) assert.deepEqual(fs.readFileSync(item.file), item.before);
});

test("启动器加核心时解析到核心实现", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-service-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "browser-service.mjs"), LAUNCHER(true));
  fs.writeFileSync(path.join(root, "browser-service-core.mjs"), SERVICE);
  assert.equal(resolveServiceImplementation(root), path.join(root, "browser-service-core.mjs"));
});

test("只有启动器没有核心时拒绝解析", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-service-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "browser-service.mjs"), LAUNCHER(true));
  assert.throws(() => resolveServiceImplementation(root, "launcher-only"), /networkPolicy/);
});

test("纯客户端目录没有服务实现", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-service-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "browser-client.mjs"), "export const revision = 2;");
  assert.equal(resolveServiceImplementation(root), null);
});

test("服务文件被改名时明确失败而不是当作纯客户端目录", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-service-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "browser-action-service.js"), "export const revision = 2;");
  fs.writeFileSync(path.join(root, "browser-service.js"), SERVICE);
  assert.throws(() => resolveServiceImplementation(root, "renamed"), /未知的浏览器服务文件名.*browser-service\.js/);
});

test("旧安装缺少核心时新增安装，重复检查为空", (t) => {
  const options = fixture(t);
  for (const directory of RUNTIME_DIRS) {
    fs.rmSync(path.join(options.resourcesRoot, directory, "browser-service-core.mjs"), { force: true });
  }
  const plan = planRepair(options);
  const created = plan.filter((item) => item.before === null);
  assert.deepEqual(created.map((item) => path.basename(item.file)), ["browser-service-core.mjs"]);

  const backup = applyRepair(plan, path.join(options.root, "backups"));
  const manifest = JSON.parse(fs.readFileSync(path.join(backup, "manifest.json")));
  assert.equal(manifest.length, plan.length);
  const createdManifest = manifest.find((item) => item.file === created[0].file);
  assert.equal(createdManifest.backup, null);
  assert.equal(createdManifest.beforeSha256, null);
  assert.deepEqual(
    fs.readFileSync(created[0].file),
    fs.readFileSync(path.join(options.sourceRoot, RUNTIME_DIRS[0], "browser-service-core.mjs")),
  );
  assert.equal(planRepair(options).length, 0);
});

test("新增产物写入中途失败时连新增文件一起回滚", (t) => {
  const options = fixture(t);
  for (const directory of RUNTIME_DIRS) {
    fs.rmSync(path.join(options.resourcesRoot, directory, "browser-service-core.mjs"), { force: true });
  }
  const plan = planRepair(options);
  const [created] = plan.filter((item) => item.before === null);
  assert.ok(created, "计划应包含新增的核心文件");
  const lastFile = plan.at(-1).file;
  assert.throws(() => applyRepair(plan, path.join(options.root, "backups"), (file, data) => {
    fs.writeFileSync(file, data);
    if (file === lastFile) throw new Error("模拟磁盘写入失败");
  }), /已回滚/);

  assert.equal(fs.existsSync(created.file), false);
  for (const item of plan) {
    if (item.before === null) continue;
    assert.deepEqual(fs.readFileSync(item.file), item.before);
  }
});

test("不把缺少策略读取或传递的旧运行时安装为修复", () => {
  assert.doesNotThrow(() => assertNetworkPolicySupport(SERVICE, "complete"));
  assert.throws(() => assertNetworkPolicySupport(SERVICE.replace("await this.config.readRequirements()", "null"), "partial"), /networkPolicy/);
  assert.throws(() => assertNetworkPolicySupport(SERVICE.replace("networkPolicy: policy", "other: policy"), "partial"), /networkPolicy/);
  assert.throws(() => assertNetworkPolicySupport(SERVICE.replace(", await this.readNetworkPolicy()", ""), "partial"), /networkPolicy/);
});

test("写入中途失败时恢复所有触碰的文件", (t) => {
  const options = fixture(t);
  const plan = planRepair(options);
  let calls = 0;
  assert.throws(() => applyRepair(plan, path.join(options.root, "backups"), (file, data) => {
    fs.writeFileSync(file, data);
    if (++calls === 2) throw new Error("模拟磁盘写入失败");
  }), /已回滚/);
  for (const item of plan) assert.deepEqual(fs.readFileSync(item.file), item.before);
});

test("计划建立后目标变化时拒绝覆盖", (t) => {
  const options = fixture(t);
  const plan = planRepair(options);
  fs.writeFileSync(plan[0].file, "changed-by-user");
  assert.throws(() => applyRepair(plan, path.join(options.root, "backups")), /目标已变化/);
  assert.equal(fs.readFileSync(plan[0].file, "utf8"), "changed-by-user");
  assert.equal(fs.existsSync(path.join(options.root, "backups")), false);
});

test("同步已安装插件缓存，不改其他插件和用户配置", (t) => {
  const options = fixture(t);
  options.codexHome = path.join(options.root, "codex-home");
  const cache = path.join(options.codexHome, "plugins/cache/openai-bundled");
  fs.mkdirSync(cache, { recursive: true });
  const versions = ["26.1016.51333", "26.1120.6357"];
  for (const plugin of ["browser", "chrome"]) {
    for (const version of versions) {
      fs.cpSync(path.join(options.resourcesRoot, `plugins/openai-bundled/plugins/${plugin}`),
        path.join(cache, plugin, version), { recursive: true });
    }
  }
  fs.cpSync(path.join(options.resourcesRoot, "plugins/openai-bundled/plugins/computer-use"),
    path.join(cache, "computer-use/26.1016.51333"), { recursive: true });
  fs.writeFileSync(path.join(options.codexHome, "config.toml"), "existing-user-config");
  const plan = planRepair(options);
  const cached = (plugin) => plan.filter((item) => item.file.startsWith(path.join(cache, plugin) + path.sep));
  // browser 入口每版本 4 个文件、chrome 入口每版本 1 个；两个版本共 10 个。
  for (const version of versions) {
    const inVersion = (plugin) =>
      plan.filter((item) => item.file.startsWith(path.join(cache, plugin, version) + path.sep)).length;
    assert.equal(inVersion("browser"), 4);
    assert.equal(inVersion("chrome"), 1);
  }
  assert.equal(cached("browser").length + cached("chrome").length, 10);
  assert.equal(cached("computer-use").length, 1);
  applyRepair(plan, path.join(options.root, "backups"));
  assert.equal(planRepair(options).length, 0);
  assert.equal(fs.readFileSync(path.join(options.codexHome, "config.toml"), "utf8"), "existing-user-config");
});

test("技能修补保留原生工作流和换行，重复执行不追加内容", () => {
  const source = SKILL.replace(/\n/g, "\r\n");
  const first = patchSource(source, "skill");
  assert.equal(first.changed, true);
  assert.ok(first.source.endsWith(source.slice(source.indexOf("## Initialize"))));
  assert.equal(first.source.replace(/\r\n/g, "").includes("\n"), false);
  assert.deepEqual(patchSource(first.source, "skill"), { source: first.source, changed: false });
  assert.throws(() => patchSource("unknown upstream", "skill"), /未知/);
});

test("真实生成运行时向扩展传递原始策略，读取失败时终止 attach", async (t) => {
  const sourceRoot = path.join(__dirname, "../src/win");
  if (!fs.existsSync(sourceRoot)) return t.skip("未生成 Windows 上游资源");
  const validated = [];
  for (const directory of RUNTIME_DIRS) {
    const dir = path.join(sourceRoot, directory);
    const service = resolveServiceImplementation(dir);
    if (!service) {
      // 纯客户端目录没有服务实现，只确认客户端存在且可解析。
      const client = path.join(dir, "browser-client.mjs");
      assert.ok(fs.existsSync(client), `${directory}: 缺少 browser-client.mjs`);
      parse(fs.readFileSync(client, "utf8"), { ecmaVersion: "latest", sourceType: "module" });
      continue;
    }
    validated.push(directory);
    const source = fs.readFileSync(service, "utf8");
    assertNetworkPolicySupport(source, directory);
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    let attach;
    let attachTab;
    function walk(node) {
      if (!node?.type) return;
      if (node.type === "MethodDefinition") {
        const raw = source.slice(node.start, node.end);
        if (node.key.name === "attach" && raw.includes("networkPolicy:")) attach = raw;
        if (node.key.name === "attachTab" && raw.includes("this.readNetworkPolicy()")) attachTab = raw;
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(walk);
        else if (value?.type) walk(value);
      }
    }
    walk(ast);
    const Client = Function(`return class { ${attach} }`)();
    const client = new Client();
    const policy = { constraints: [{ kind: "origins", mode: "denylist", patterns: ["https://blocked.example"] }] };
    client.sendSessionRequest = (method, params) => ({ method, params });
    const forwarded = client.attach(7, policy);
    assert.equal(forwarded.method, "attach");
    assert.equal(forwarded.params.networkPolicy, policy);
    const CDP = Function(`return class { ${attachTab} }`)();
    const cdp = new CDP();
    cdp.readNetworkPolicy = async () => { throw new Error("policy unavailable"); };
    cdp.api = { attach: () => assert.fail("策略读取失败后不应接管标签页") };
    await assert.rejects(cdp.attachTab(7, {}, () => true), /policy unavailable/);
  }
  // 第 1 个入口经核心校验，第 3 个入口经单文件服务校验；两者都必须被覆盖。
  assert.deepEqual(validated, [RUNTIME_DIRS[0], RUNTIME_DIRS[2]]);
});