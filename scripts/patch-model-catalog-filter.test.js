const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const { patchSource, findTargets } = require("./patch-model-catalog-filter");

const PATCHABLE_SOURCE = [
  "function filter({authMethod:t,availableModels:n,model:a,useHiddenModels:o}){",
  "return o&&t!==`amazonBedrock`?n.has(a.model):!a.hidden",
  "}",
].join("");

// 只提到字段、没有 allowlist 条件，预筛会命中但无法安全改写。
const LOOK_ALIKE_SOURCE = [
  "function filter({availableModels:n,model:a,useHiddenModels:o}){",
  "return o?!a.hidden:Boolean(n&&n.model&&n.has(a.model))",
  "}",
].join("");

/** 在临时目录下创建 <platform>/_asar/webview/assets 及给定分片。 */
function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-model-catalog-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, "win", "_asar", "webview", "assets", "async");
  fs.mkdirSync(assets, { recursive: true });
  for (const [name, source] of Object.entries(files)) {
    fs.writeFileSync(path.join(assets, name), source);
  }
  return root;
}

test("新版模型目录条件不再依赖 availableModels allowlist", () => {
  const source = [
    "function filter({authMethod:t,availableModels:n,model:a,useHiddenModels:o}){",
    "return o&&t!==`amazonBedrock`?n.has(a.model):!a.hidden",
    "}",
  ].join("");

  const result = patchSource(source);

  assert.equal(result.status, "patched");
  assert.match(result.source, /模型目录忽略服务端 allowlist。 \*\/!a\.hidden/);
  assert.doesNotMatch(result.source, /n\.has\(a\.model\)/);
  assert.equal(patchSource(result.source).status, "already-patched");
});

test("旧版 if 条件同样按 AST 结构改写", () => {
  const source = [
    "function filter(flag,availableModels,model){",
    "if(flag?availableModels.has(model.model):!model.hidden)return model;",
    "}",
  ].join("");

  const result = patchSource(source);

  assert.equal(result.status, "patched");
  assert.match(result.source, /if\(\/\* Codex：模型目录忽略服务端 allowlist。 \*\/!model\.hidden\)/);
});

test("同一 bundle 内的多个模型目录路径会全部改写", () => {
  const source = [
    "function first(flag,models,model){return flag?models.has(model.model):!model.hidden}",
    "function second(flag,catalog,item){return flag?catalog.has(item.model):!item.hidden}",
  ].join("");

  const result = patchSource(source);

  assert.equal(result.status, "patched");
  assert.equal(result.patches.length, 2);
  assert.doesNotMatch(result.source, /\.has\(/);
  assert.equal(patchSource(result.source).status, "already-patched");
});

test("未知模型目录结构明确报错", () => {
  const source = "function filter(model){return !model.hidden}";

  const result = patchSource(source);

  assert.equal(result.status, "unexpected-anchor-count");
  assert.equal(result.count, 0);
});

test("新版访问计划分支只显示未隐藏模型且保留前置拒绝条件", () => {
  const source = "function filter(flag,list,model,denied,extra){return denied?!1:(flag?list.has(model.model)||extra&&!model.hidden:!model.hidden)}";
  const result = patchSource(source);
  assert.equal(result.status, "patched");
  const filter = vm.runInNewContext(`${result.source};filter`);
  assert.equal(filter(true, new Set(), { model: "custom", hidden: false }, false, false), true);
  assert.equal(filter(true, new Set(["custom"]), { model: "custom", hidden: true }, false, true), false);
  assert.equal(filter(true, new Set(), { model: "custom", hidden: false }, true, true), false);
  assert.equal(patchSource(result.source).status, "already-patched");
});

test("可改写文件与仅形似的候选分别进入 targets 和 dropped", (t) => {
  const root = fixture(t, {
    "900001.deadbeef.js": PATCHABLE_SOURCE,
    "900002.cafebabe.js": LOOK_ALIKE_SOURCE,
  });

  const { targets, dropped } = findTargets("win", { srcDir: root });

  assert.equal(targets.length, 1);
  assert.equal(path.basename(targets[0].path), "900001.deadbeef.js");
  assert.equal(targets[0].result.status, "patched");
  assert.equal(dropped.length, 1);
  assert.equal(path.basename(dropped[0].path), "900002.cafebabe.js");
  assert.equal(dropped[0].platform, "win");
  assert.equal(dropped[0].status, "unexpected-anchor-count");
  assert.equal(dropped[0].count, 0);
});

test("只有形似候选时 targets 为空且候选被明确拒绝", (t) => {
  const root = fixture(t, { "900002.cafebabe.js": LOOK_ALIKE_SOURCE });

  const { targets, dropped } = findTargets("win", { srcDir: root });

  assert.deepEqual(targets, []);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].status, "unexpected-anchor-count");
});
