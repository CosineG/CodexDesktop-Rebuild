const test = require("node:test");
const assert = require("node:assert/strict");

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

test("26.1002 逻辑或分支中的 allowlist 网关同样改写", () => {
  const source = [
    "function gate({additionalAvailableModels:e,apiKeyDaybreakSupported:t,authMethod:n,availableModels:r,hasConfiguredModelCatalog:i,isCustomModelProvider:a,model:o,useHiddenModels:s}){",
    "let c=o.availableAccessPrograms?.cyber;",
    "return n===`apikey`&&!t&&c!=null&&c.length>0&&!c.includes(`standard`)?!1:e?.has(o.model)===!0||o.model!==`codex-auto-review`&&(i&&!o.hidden||(s&&!a&&n!==`amazonBedrock`?r.has(o.model)||n===`apikey`&&t&&!o.hidden&&c?.some(e=>e!==`standard`)===!0:!o.hidden))",
    "}",
  ].join("");

  const result = patchSource(source);

  assert.equal(result.status, "patched");
  assert.equal(result.patches.length, 1);
  assert.doesNotMatch(result.source, /r\.has\(o\.model\)/);
  assert.match(result.source, /模型目录忽略服务端 allowlist。 \*\/!o\.hidden/);
  // additionalAvailableModels 的本地放行条件不应被误伤
  assert.match(result.source, /e\?\.has\(o\.model\)===!0/);
  assert.equal(patchSource(result.source).status, "already-patched");
});

test("仅含调用点、没有 allowlist 成员测试的 bundle 视为无网关", () => {
  const source = [
    "function pick(d){return Yg({availableModels:d.availableModels,useHiddenModels:d.useHiddenModels})}",
    "function style(e){e.hidden=!1}",
  ].join("");

  const result = patchSource(source);

  assert.equal(result.status, "no-allowlist-gate");
});

test("存在成员测试但网关结构无法识别时仍显式报错", () => {
  const source =
    "function filter(set,model){if(set.has(model.model))return!0;return!model.hidden}";

  const result = patchSource(source);

  assert.equal(result.status, "unexpected-anchor-count");
  assert.equal(result.count, 0);
});

test("嵌套网关只改写最外层，输出保持可解析", () => {
  const source = [
    "function f(a,set,catalog,model){",
    "return a?(set.has(model.model)||(a?catalog.has(model.model):!model.hidden)):!model.hidden",
    "}",
  ].join("");

  const result = patchSource(source);

  assert.equal(result.status, "patched");
  assert.equal(result.patches.length, 1);
  assert.doesNotMatch(result.source, /\.has\(model\.model\)/);
  assert.match(result.source, /模型目录忽略服务端 allowlist。 \*\/!model\.hidden\}/);
});

test("consequent 深层嵌套的成员测试不构成网关", () => {
  const source =
    "function f(flag,other,model){return flag?[1,2].map(x=>other.has(model.model)).length>0:!model.hidden}";

  const result = patchSource(source);

  assert.equal(result.status, "unexpected-anchor-count");
});

test("成员测试写法变化时仍显式报错而非静默跳过", () => {
  const source = [
    "function pick(d){return Yg({availableModels:d.availableModels,useHiddenModels:d.useHiddenModels})}",
    "function gate(flag,catalog,model){return flag?catalog.includes(model.model):!model.hidden}",
  ].join("");

  const result = patchSource(source);

  assert.equal(result.status, "unexpected-anchor-count");
});

test("成员测试针对其他对象时不视为该网关", () => {
  const source =
    "function f(flag,set,other,model){return flag?set.has(other.model):!model.hidden}";

  const result = patchSource(source);

  assert.equal(result.status, "unexpected-anchor-count");
});
