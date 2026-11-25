const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { parse } = require("acorn");

const {
  TRANSLATIONS,
  patchSource,
  patchLocaleCatalog,
  findTargets,
} = require("./patch-reasoning-effort-labels");

test("数字分片通过 locale 导入映射定位简体中文，不修改其他语言", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-locales-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, "win/_asar/webview/assets");
  fs.mkdirSync(path.join(assets, "async"), { recursive: true });
  fs.writeFileSync(path.join(assets, "async/registry.hash.js"),
    'const locales={"../locales/zh-CN.json":function(){return i.e(1561).then(i.t.bind(i,"cn",19))},"../locales/zh-TW.json":function(){return i.e(256801).then(i.t.bind(i,"tw",19))}}');
  for (const name of ["1561.hash.js", "256801.hash.js"]) {
    fs.writeFileSync(path.join(assets, "async", name), "export const locale={}");
  }
  const result = findTargets("win", root);
  assert.deepEqual(result.invalidPlatforms, []);
  assert.deepEqual(result.targets.map((item) => path.basename(item.path)), ["1561.hash.js"]);
});

test("Rspack JSON 语言包补丁保留其他消息、引号转义且重复执行稳定", () => {
  const messages = { ...TRANSLATIONS, "composer.mode.local.reasoning.none.label": "无", unrelated: "引号'与反斜线\\" };
  const source = `export const __webpack_modules__={cn(e){e.exports=JSON.parse(${JSON.stringify(JSON.stringify(messages))})}}`;
  const result = patchSource(source);
  assert.equal(result.status, "patched");
  const ast = parse(result.source, { ecmaVersion: "latest", sourceType: "module" });
  const literal = ast.body[0].declaration.declarations[0].init.properties[0].value.body.body[0].expression.right.arguments[0];
  assert.deepEqual(JSON.parse(literal.value), { ...messages, ...TRANSLATIONS });
  assert.equal(patchSource(result.source).status, "already-patched");
  delete messages["composer.mode.local.reasoning.max.label"];
  const incomplete = `JSON.parse(${JSON.stringify(JSON.stringify(messages))})`;
  assert.equal(patchSource(incomplete).status, "unexpected-entry-count");
});

function createLocaleSource(overrides = {}) {
  const translations = { ...TRANSLATIONS, ...overrides };
  const entries = Object.keys(TRANSLATIONS).map(
    (messageId) => `"${messageId}":\`${translations[messageId]}\``,
  );
  return `const messages={${entries.join(",")}};export{messages as default};`;
}

test("为全部推理强度补充实际参数并说明 Ultra", () => {
  const source = createLocaleSource({
    "composer.mode.local.reasoning.low.label.v2": "轻度",
    "composer.mode.local.reasoning.ultra.label": "极高",
    "composer.modelPicker.power.ultraUsageWarning": "更快消耗使用额度",
  });

  const result = patchSource(source);

  assert.equal(result.status, "patched");
  for (const [messageId, translation] of Object.entries(TRANSLATIONS)) {
    assert.match(result.source, new RegExp(`"${messageId.replaceAll(".", "\\.")}":\`${translation}\``));
  }
});

test("兼容旧版 low 消息 ID", () => {
  const source = createLocaleSource({
    "composer.mode.local.reasoning.low.label.v2": "轻度",
  }).replace(
    "composer.mode.local.reasoning.low.label.v2",
    "composer.mode.local.reasoning.low.label",
  );

  const result = patchSource(source);

  assert.equal(result.status, "patched");
  assert.match(
    result.source,
    /"composer\.mode\.local\.reasoning\.low\.label":`轻度（low）`/,
  );
});

test("重复执行不会再次修改语言包", () => {
  const source = createLocaleSource();
  const result = patchSource(source);

  assert.equal(result.status, "already-patched");
  assert.equal(result.source, source);
});

test("关键消息缺失时失败，避免静默产生不完整补丁", () => {
  const source = createLocaleSource().replace(
    /"composer\.mode\.local\.reasoning\.max\.label":`[^`]*`,?/,
    "",
  );
  const result = patchSource(source);

  assert.equal(result.status, "unexpected-entry-count");
  assert.deepEqual(result.invalidEntries, [
    {
      messageId: "composer.mode.local.reasoning.max.label",
      count: 0,
    },
  ]);
});

const GZIP_SUFFIX = ".json.codex-gzip";
const ZH_GROUP = "4f006d52a0676d42";

function readGzipJson(file) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
}

function writeGzipJson(file, value) {
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify(value), "utf8")));
}

/** 构建新版 locales 目录：共享 keys + zh-CN 译文 + 第二语言译文。 */
function createGzipFixture(t, { group = ZH_GROUP } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-locales-gzip-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const locales = path.join(root, "win/_asar/webview/assets/locales");
  fs.mkdirSync(locales, { recursive: true });

  const keys = [
    ...Object.keys(TRANSLATIONS),
    "composer.mode.local.reasoning.persistent.label",
    "unrelated.message",
  ];
  const zhValues = [
    ...Object.keys(TRANSLATIONS).map((messageId) => `旧-${messageId}`),
    "持续",
    "无关消息'与\\转义",
  ];
  const twValues = zhValues.map((value) => `繁-${value}`);

  const keysPath = path.join(locales, `keys.${ZH_GROUP}${GZIP_SUFFIX}`);
  const zhPath = path.join(
    locales,
    `zh-CN.keys.${group}.abc123${GZIP_SUFFIX}`,
  );
  const twPath = path.join(
    locales,
    `zh-TW.keys.${ZH_GROUP}.def456${GZIP_SUFFIX}`,
  );
  writeGzipJson(keysPath, keys);
  writeGzipJson(zhPath, zhValues);
  writeGzipJson(twPath, twValues);

  return { root, locales, keysPath, zhPath, twPath, keys, zhValues, twValues };
}

test("新版 gzip 语言目录只定位简体中文并补齐翻译", (t) => {
  const fixture = createGzipFixture(t);
  const found = findTargets("win", fixture.root);

  assert.deepEqual(found.invalidPlatforms, []);
  assert.equal(found.targets.length, 1);
  assert.equal(found.targets[0].kind, "gzip");
  assert.equal(path.basename(found.targets[0].path), path.basename(fixture.zhPath));
  assert.equal(
    path.basename(found.targets[0].keysPath),
    `keys.${ZH_GROUP}${GZIP_SUFFIX}`,
  );

  const twBefore = fs.readFileSync(fixture.twPath);
  const result = patchLocaleCatalog(
    fs.readFileSync(fixture.zhPath),
    fs.readFileSync(fixture.keysPath),
  );

  assert.equal(result.status, "patched");
  assert.equal(result.patches.length, Object.keys(TRANSLATIONS).length);
  fs.writeFileSync(fixture.zhPath, result.source);

  // 只替换推理强度消息，其余消息与译文保持语义不变。
  const patched = readGzipJson(fixture.zhPath);
  assert.equal(patched.length, fixture.zhValues.length);
  fixture.keys.forEach((messageId, index) => {
    assert.equal(
      patched[index],
      Object.hasOwn(TRANSLATIONS, messageId)
        ? TRANSLATIONS[messageId]
        : fixture.zhValues[index],
    );
  });

  const idempotent = patchLocaleCatalog(
    fs.readFileSync(fixture.zhPath),
    fs.readFileSync(fixture.keysPath),
  );
  assert.equal(idempotent.status, "already-patched");
  // 第二语言文件完全未被触及。
  assert.ok(fs.readFileSync(fixture.twPath).equals(twBefore));
});

test("keys 组哈希不匹配时回退到含目标消息的 keys 目录", (t) => {
  const fixture = createGzipFixture(t, { group: "deadbeefdeadbeef" });
  const found = findTargets("win", fixture.root);

  assert.deepEqual(found.invalidPlatforms, []);
  assert.equal(found.targets.length, 1);
  assert.equal(
    path.basename(found.targets[0].keysPath),
    `keys.${ZH_GROUP}${GZIP_SUFFIX}`,
  );
});

test("新版 gzip 语言目录缺少关键消息时失败", (t) => {
  const fixture = createGzipFixture(t);
  const removeId = "composer.mode.local.reasoning.max.label";
  const indexes = fixture.keys
    .map((messageId, index) => ({ messageId, index }))
    .filter(({ messageId }) => messageId !== removeId);

  writeGzipJson(
    fixture.keysPath,
    indexes.map(({ messageId }) => messageId),
  );
  writeGzipJson(
    fixture.zhPath,
    indexes.map(({ index }) => fixture.zhValues[index]),
  );

  const result = patchLocaleCatalog(
    fs.readFileSync(fixture.zhPath),
    fs.readFileSync(fixture.keysPath),
  );

  assert.equal(result.status, "unexpected-entry-count");
  assert.deepEqual(result.invalidEntries, [{ messageId: removeId, count: 0 }]);
});

test("keys 与译文长度不一致时按对齐异常失败", (t) => {
  const fixture = createGzipFixture(t);
  const misaligned = fixture.zhValues.slice(0, -1);
  writeGzipJson(fixture.zhPath, misaligned);

  const result = patchLocaleCatalog(
    fs.readFileSync(fixture.zhPath),
    fs.readFileSync(fixture.keysPath),
  );

  assert.equal(result.status, "unexpected-entry-count");
  assert.deepEqual(result.invalidEntries, [
    { messageId: "locale catalog alignment", count: misaligned.length },
  ]);
});

test("目标译文不是字符串时失败而不是写入语言包", (t) => {
  const fixture = createGzipFixture(t);
  const messageId = "composer.mode.local.reasoning.none.label";
  const values = [...fixture.zhValues];
  values[fixture.keys.indexOf(messageId)] = 42;
  writeGzipJson(fixture.zhPath, values);

  const result = patchLocaleCatalog(
    fs.readFileSync(fixture.zhPath),
    fs.readFileSync(fixture.keysPath),
  );

  assert.equal(result.status, "unexpected-entry-count");
  assert.deepEqual(result.invalidEntries, [
    { messageId, count: 1, nonString: true },
  ]);
});

test("损坏的语言目录字节按解析失败处理", (t) => {
  const fixture = createGzipFixture(t);
  fs.writeFileSync(fixture.zhPath, Buffer.from("not a gzip catalog"));

  const result = patchLocaleCatalog(
    fs.readFileSync(fixture.zhPath),
    fs.readFileSync(fixture.keysPath),
  );

  assert.equal(result.status, "parse-failed");
  assert.ok(result.error instanceof Error);
});
