const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parse } = require("acorn");

const { PATCH_MARKER, locateTargets, collectPatches } = require("./patch-i18n");

/** 在临时目录下创建 webview/assets/async 分片，返回测试用 src 根目录。 */
function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-i18n-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, "mac-arm64", "_asar", "webview", "assets");
  fs.mkdirSync(path.join(assets, "async"), { recursive: true });
  for (const [name, source] of Object.entries(files)) {
    fs.writeFileSync(path.join(assets, "async", name), source);
  }
  return root;
}

/** 按补丁偏移替换源码，供幂等性断言使用。 */
function applyPatches(source, patches) {
  let next = source;
  for (const patch of [...patches].sort((left, right) => right.start - left.start)) {
    next = next.slice(0, patch.start) + patch.replacement + next.slice(patch.end);
  }
  return next;
}

test("递归发现 async 分片中的 i18n 开关", (t) => {
  const root = fixture(t, {
    "900001.deadbeef.js": 'const flag=cfg.get("enable_i18n",!1);',
    "900002.cafebabe.js": "const unrelated=!0;",
  });

  const targets = locateTargets("mac-arm64", { srcDir: root });

  assert.equal(targets.length, 1);
  assert.equal(targets[0].platform, "mac-arm64");
  assert.equal(targets[0].patched, false);
  assert.match(targets[0].path, /assets[\\/]async[\\/]900001\.deadbeef\.js$/);
});

test("AST 改写写入标记，重复执行识别为已启用", (t) => {
  const root = fixture(t, {
    "900001.deadbeef.js": 'const flag=cfg.get("enable_i18n",!1);',
  });
  const target = locateTargets("mac-arm64", { srcDir: root })[0];
  const source = fs.readFileSync(target.path, "utf-8");

  const patches = collectPatches(
    parse(source, { ecmaVersion: "latest", sourceType: "module" }),
    source,
  );
  assert.equal(patches.length, 1);
  assert.equal(patches[0].replacement, PATCH_MARKER);

  const patched = applyPatches(source, patches);
  assert.equal(patched, `const flag=${PATCH_MARKER};`);
  assert.match(patched, /!0\/\*codex-i18n-enabled\*\//);
  assert.equal(
    collectPatches(
      parse(patched, { ecmaVersion: "latest", sourceType: "module" }),
      patched,
    ).length,
    0,
  );

  // 写回后重新扫描：闸门字符串已消失，但标记表明是本补丁启用的。
  fs.writeFileSync(target.path, patched);
  const rerun = locateTargets("mac-arm64", { srcDir: root });
  assert.equal(rerun.length, 1);
  assert.equal(rerun[0].patched, true);
});

test("既没有闸门也没有标记时目标列表为空且不报错", (t) => {
  const root = fixture(t, { "900001.deadbeef.js": "const unrelated=!0;" });

  assert.deepEqual(locateTargets("mac-arm64", { srcDir: root }), []);
});