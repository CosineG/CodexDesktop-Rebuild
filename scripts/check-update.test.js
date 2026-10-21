const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const { findUpdates, resolveVersionFile, summarizeChecks } = require("./check-update");

const CURRENT_PLATFORMS = [
  { platform: "macOS-arm64", version: "26.721.41059", build: "5848" },
  { platform: "macOS-x64", version: "26.721.41059", build: "5848" },
  { platform: "Windows", version: "26.721.4979.0", build: "" },
];

const SAVED_VERSIONS = {
  "macOS-arm64": { version: "26.721.41059", build: "5848" },
  "macOS-x64": { version: "26.721.41059", build: "5848" },
  Windows: { version: "26.721.4979.0" },
};

test("各平台版本与各自记录一致时不触发更新", () => {
  assert.deepEqual(findUpdates(CURRENT_PLATFORMS, SAVED_VERSIONS), []);
});

test("Windows 单独更新时仍触发构建", () => {
  const platforms = CURRENT_PLATFORMS.map((info) =>
    info.platform === "Windows"
      ? { ...info, version: "26.721.5000.0" }
      : info
  );

  assert.deepEqual(
    findUpdates(platforms, SAVED_VERSIONS).map((info) => info.platform),
    ["Windows"]
  );
});

test("不同平台版本号不同不会造成重复更新", () => {
  assert.notEqual(
    SAVED_VERSIONS["macOS-arm64"].version,
    SAVED_VERSIONS.Windows.version
  );
  assert.equal(findUpdates(CURRENT_PLATFORMS, SAVED_VERSIONS).length, 0);
});

test("可以为 CI 指定持久化版本记录", () => {
  assert.equal(
    resolveVersionFile(["--state-file", ".github/upstream-versions.json"]),
    path.resolve(process.cwd(), ".github/upstream-versions.json")
  );
});

test("缺少状态文件路径时直接失败", () => {
  assert.throws(
    () => resolveVersionFile(["--state-file", "--json"]),
    /需要提供文件路径/
  );
});

test("单个平台检测失败会保留错误而不是伪装全部成功", () => {
  const result = summarizeChecks([
    { status: "fulfilled", value: CURRENT_PLATFORMS[0] },
    { status: "fulfilled", value: CURRENT_PLATFORMS[1] },
    { status: "rejected", reason: new Error("下载链接不可用") },
  ]);
  assert.equal(result.results.length, 2);
  assert.deepEqual(result.errors, { Windows: "下载链接不可用" });
});
