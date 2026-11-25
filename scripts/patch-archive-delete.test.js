const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findNativeBundles } = require("./patch-archive-delete");

// 26.1120 原生删除链路的完整标记集合。
const NATIVE_1120 = [
  'const route="delete-archived-conversations";',
  "deleteArchivedConversation();",
  "deleteAllArchivedConversations();",
  'sendRequest("thread/delete");',
  'const title=t("settings.dataControls.archivedChats.deleteWithTitle");',
].join("");

test("递归发现 async 目录中的原生删除链路", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-archive-delete-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, "win", "_asar", "webview", "assets");
  fs.mkdirSync(path.join(assets, "async", "nested"), { recursive: true });
  fs.writeFileSync(path.join(assets, "async", "nested", "x.js"), NATIVE_1120);
  fs.writeFileSync(path.join(assets, "async", "unrelated.js"), "export const value=1;");

  const bundles = findNativeBundles(["win"], { srcDir: root });

  assert.equal(bundles.length, 1);
  assert.equal(bundles[0].platform, "win");
  assert.equal(
    path.relative(assets, bundles[0].path).split(path.sep).join("/"),
    "async/nested/x.js",
  );
});