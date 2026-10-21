const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const acorn = require("acorn");

test("更新器检查模式不写文件，应用模式禁用自动更新", () => {
  const script = fs.readFileSync(path.join(__dirname, "patch-updater.js"), "utf8");
  const source = "const updater={shouldIncludeUpdater(){return enabled},shouldIncludeSparkle(){return supported}};";
  for (const check of [true, false]) {
    const writes = [];
    vm.runInNewContext(script, {
      process: { argv: ["node", "patch-updater.js", "win", ...(check ? ["--check"] : [])] },
      console: { log() {} },
      require: (name) => {
        if (name === "fs") return {
          existsSync: () => true,
          readdirSync: () => ["main-test.js"],
          readFileSync: () => source,
          writeFileSync: (_file, value) => writes.push(value),
        };
        if (name === "path") return path;
        if (name === "acorn") return acorn;
        if (name === "./patch-util") return { SRC_DIR: "fixture", relPath: value => value };
        throw new Error(`非预期依赖: ${name}`);
      },
    });
    assert.equal(writes.length, check ? 0 : 1);
    if (!check) {
      const updater = vm.runInNewContext(`${writes[0]};updater`, { enabled: true, supported: true });
      assert.equal(updater.shouldIncludeUpdater(), false);
      assert.equal(updater.shouldIncludeSparkle(), false);
    }
  }
});
