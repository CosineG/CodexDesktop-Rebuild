const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const { patchSource } = require("./patch-model-catalog-filter");

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
