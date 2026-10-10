const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { runPatches } = require("./patch-all");
const { PATCH_POLICY } = require("./patch-policy");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-patch-report-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "win", "_asar"), { recursive: true });
  fs.writeFileSync(path.join(root, "win", "_asar", "package.json"), JSON.stringify({ version: "26.1007.21159" }));
  return root;
}

function write(root, relative, source) {
  const file = path.join(root, "win", "_asar", relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
  return file;
}

function policy(...scripts) {
  return PATCH_POLICY.filter((item) => scripts.includes(item.script));
}

test("真实 updater 补丁的预检查不修改资源，应用后关闭更新", (t) => {
  const root = fixture(t);
  const source = "const updater={shouldIncludeSparkle(){return true},shouldIncludeUpdater(){return true}};";
  const file = write(root, ".vite/build/main-test.js", source);
  const options = { platform: "win", sourceDir: root, policy: policy("patch-updater.js"), log: () => {} };

  const checked = runPatches({ ...options, check: true });
  assert.equal(checked.canBuild, true);
  assert.equal(fs.readFileSync(file, "utf8"), source);

  assert.equal(runPatches(options).canBuild, true);
  const updater = Function(`${fs.readFileSync(file, "utf8")};return updater`)();
  assert.equal(updater.shouldIncludeSparkle(), false);
  assert.equal(updater.shouldIncludeUpdater(), false);
});

test("可选版权补丁失败时保留上游文件，严格模式阻止继续", (t) => {
  const root = fixture(t);
  const first = "const broken=;";
  const firstFile = write(root, ".vite/build/main-a.js", first);
  const reportDir = path.join(root, "report");
  const options = { platform: "win", sourceDir: root, reportDir, policy: policy("patch-copyright.js"), log: () => {} };

  const report = runPatches(options);
  assert.equal(report.canBuild, true);
  assert.equal(report.results[0].status, "warning");
  assert.equal(report.results[0].restored, true);
  assert.equal(fs.readFileSync(firstFile, "utf8"), first);
  assert.equal(JSON.parse(fs.readFileSync(path.join(reportDir, "report.json"))).canBuild, true);
  const logFile = fs.readFileSync(path.join(reportDir, report.results[0].logFile), "utf8");
  assert.match(logFile, /SyntaxError/);

  const strict = runPatches({ ...options, strict: true });
  assert.equal(strict.canBuild, false);
  assert.equal(fs.readFileSync(firstFile, "utf8"), first);

  fs.writeFileSync(firstFile, "const updater={shouldIncludeSparkle(){return true},shouldIncludeUpdater(){return true}};");
  assert.equal(runPatches({ ...options, policy: policy("patch-updater.js") }).canBuild, true);
  const updater = Function(`${fs.readFileSync(firstFile, "utf8")};return updater`)();
  assert.equal(updater.shouldIncludeUpdater(), false);
});

test("可选补丁已写文件但报告写入失败时回滚并阻止构建", (t) => {
  const root = fixture(t);
  const source = "const about={copyright:'© OpenAI'};";
  const file = write(root, ".vite/build/main-test.js", source);
  const reportDir = path.join(root, "report");
  fs.mkdirSync(path.join(reportDir, "logs", "win-patch-copyright.js.log"), { recursive: true });

  const report = runPatches({ platform: "win", sourceDir: root, reportDir, policy: policy("patch-copyright.js"), log: () => {} });
  assert.equal(report.canBuild, false);
  assert.equal(report.results[0].restored, true);
  assert.equal(fs.readFileSync(file, "utf8"), source);
});

test("版权结构缺失只报告警告，后续必要补丁仍实际生效", (t) => {
  const root = fixture(t);
  const source = "const updater={shouldIncludeSparkle(){return true},shouldIncludeUpdater(){return true}};";
  const file = write(root, ".vite/build/main-test.js", source);

  const report = runPatches({ platform: "win", sourceDir: root, policy: policy("patch-copyright.js", "patch-updater.js"), log: () => {} });
  assert.equal(report.canBuild, true);
  assert.equal(report.results.find((item) => item.script === "patch-copyright.js").status, "warning");
  const updater = Function(`${fs.readFileSync(file, "utf8")};return updater`)();
  assert.equal(updater.shouldIncludeUpdater(), false);
});

test("必要补丁漂移时阻止构建，失败日志仍写入报告", (t) => {
  const root = fixture(t);
  const source = 'async function readGate(){throw new Error("Browser request-header policy requires caller identity.");checkGate("codex_browser_use_agent_request_header")}';
  const file = path.join(root, "win", "plugins", "browser", "browser-service.mjs");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
  const reportDir = path.join(root, "report");

  const report = runPatches({ platform: "win", sourceDir: root, check: true, reportDir, policy: policy("patch-browser-auth.js"), log: () => {} });
  assert.equal(report.canBuild, false);
  assert.equal(fs.readFileSync(file, "utf8"), source);
  const saved = JSON.parse(fs.readFileSync(path.join(reportDir, "report.json")));
  assert.equal(saved.results[0].status, "failed");
  assert.match(fs.readFileSync(path.join(reportDir, saved.results[0].logFile), "utf8"), /unexpected-shape/);
});

test("CLI 缺少同步资源时返回失败并生成可读报告", (t) => {
  const root = fixture(t);
  const reportDir = path.join(root, "report");
  const result = spawnSync(process.execPath, [
    path.join(__dirname, "patch-all.js"), "mac-arm64", "--check", "--source-dir", root, "--report", reportDir,
  ], { encoding: "utf8" });

  assert.equal(result.status, 1);
  const report = JSON.parse(fs.readFileSync(path.join(reportDir, "report.json")));
  assert.equal(report.canBuild, false);
  assert.match(report.errors[0], /mac-arm64/);
});
