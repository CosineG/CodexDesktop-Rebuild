#!/usr/bin/env node
/**
 * Check extracted upstream resources before packaging.
 * node scripts/patch-all.js mac-arm64 --check --report reports/mac-arm64-check
 * node scripts/patch-all.js win --report reports/win-apply
 * --strict also blocks on optional presentation patches.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { PATCH_POLICY } = require("./patch-policy");

const PLATFORMS = ["mac-arm64", "mac-x64", "win"];
const DEFAULT_SOURCE_DIR = path.join(__dirname, "..", "src");

function parseArgs(args) {
  const options = { check: false, strict: false, sourceDir: DEFAULT_SOURCE_DIR };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (PLATFORMS.includes(arg) || arg === "unix") {
      if (options.platform) throw new Error("Only one platform scope may be specified");
      options.platform = arg;
    } else if (arg === "--check") {
      options.check = true;
    } else if (arg === "--strict") {
      options.strict = true;
    } else if (arg === "--report" || arg === "--source-dir") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path`);
      options[arg === "--report" ? "reportDir" : "sourceDir"] = path.resolve(value);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function snapshotOptionalTargets(patch, sourceDir, platform) {
  if (!["translations", "main-bundles"].includes(patch.rollback)) {
    throw new Error(`Optional patch ${patch.script} needs an explicit rollback scope`);
  }
  const directory = patch.rollback === "translations"
    ? path.join(sourceDir, platform, "_asar", "webview", "assets")
    : path.join(sourceDir, platform, "_asar", ".vite", "build");
  if (!fs.existsSync(directory)) return [];
  const pattern = patch.rollback === "translations" ? /^zh-CN-.*\.js$/ : /^main(?:-[^.]+)?\.js$/;
  return fs.readdirSync(directory).filter((name) => pattern.test(name)).map((name) => {
    const file = path.join(directory, name);
    return { file, contents: fs.readFileSync(file) };
  });
}

function restoreFiles(snapshot) {
  for (const { file, contents } of snapshot) fs.writeFileSync(file, contents);
}

function markdownCell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

function renderReport(report) {
  const statuses = { passed: "脚本通过", warning: "保留上游实现", failed: "阻止构建" };
  const lines = [
    `# 上游补丁${report.mode === "check" ? "兼容检查" : "执行"}报告`,
    "",
    `构建决策：${report.canBuild ? "可以继续" : "停止，必要补丁或输入检查失败"}。`,
    "",
    ...Object.entries(report.upstream).map(([platform, info]) => `- ${platform}: ${info.version} (build ${info.build || "unknown"})`),
    "",
    "| 平台 | 补丁 | 功能 | 等级 | 结果 |",
    "|---|---|---|---|---|",
    ...report.results.map((item) =>
      `| ${markdownCell(item.platform)} | ${markdownCell(item.script)} | ${markdownCell(item.feature)} | ${item.required ? "必要" : "可选"} | ${statuses[item.status]}${item.notices?.length ? "（有匹配或跳过提示）" : ""} |`,
    ),
  ];
  if (report.errors.length > 0) lines.push("", ...report.errors.map((error) => `- ${error}`));
  for (const item of report.results.filter((result) => result.status !== "passed" || result.notices?.length)) {
    lines.push("", `## ${item.platform} / ${item.script}`, "", item.diagnostic);
    if (item.notices?.length) lines.push("", ...item.notices.map((notice) => `- ${notice}`));
    if (item.logFile) lines.push("", `完整日志：[${item.logFile}](${item.logFile})`);
  }
  lines.push("", "该报告验证补丁脚本能否处理实际提取的上游资源，不代表应用运行、登录或浏览器交互已通过验证。", "");
  return lines.join("\n");
}

function saveReport(report, reportDir) {
  const markdown = renderReport(report);
  if (reportDir) {
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
    fs.writeFileSync(path.join(reportDir, "report.md"), markdown);
  }
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
}

function runPatches({
  platform,
  sourceDir = DEFAULT_SOURCE_DIR,
  check = false,
  strict = false,
  reportDir,
  policy = PATCH_POLICY,
  log = console.log,
} = {}) {
  sourceDir = path.resolve(sourceDir);
  const requested = platform === "unix" ? PLATFORMS.slice(0, 2) : platform ? [platform] : PLATFORMS;
  const platforms = requested.filter((item) => fs.existsSync(path.join(sourceDir, item, "_asar")));
  const report = { mode: check ? "check" : "apply", strict, sourceDir, createdAt: new Date().toISOString(), upstream: {}, results: [], errors: [], canBuild: true };
  if (platform && platform !== "unix" && platforms.length === 0) {
    report.errors.push(`缺少 ${platform} 的上游 _asar 资源，请先完成同步。`);
  } else if (platforms.length === 0) {
    report.errors.push("没有提取的上游资源，请先完成同步。");
  }
  for (const item of platforms) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(sourceDir, item, "_asar", "package.json"), "utf8"));
      report.upstream[item] = { version: pkg.version || "unknown", build: pkg.codexBuildNumber || "" };
    } catch {
      report.upstream[item] = { version: "unknown", build: "" };
    }
  }
  if (reportDir) fs.mkdirSync(path.join(reportDir, "logs"), { recursive: true });

  for (const item of platforms) {
    for (const patch of policy) {
      const required = !patch.optional;
      const result = { platform: item, script: patch.script, feature: patch.feature, required };
      log(`\n== ${patch.script} (${item}, ${required ? "required" : "optional"}) ==`);
      let snapshot;
      try {
        // Restore every optional target after failure, preserving earlier patches.
        snapshot = patch.optional && !check ? snapshotOptionalTargets(patch, sourceDir, item) : [];
        const execution = spawnSync(process.execPath, [path.join(__dirname, patch.script), item, ...(check ? ["--check"] : [])], {
          encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, CODEX_PATCH_SOURCE_DIR: sourceDir },
        });
        const output = [execution.stdout, execution.stderr, execution.error?.message].filter(Boolean).join("\n");
        log(output.trimEnd());
        const findings = output.split(/\r?\n/).filter((line) => /\[x\]|\[!\]/i.test(line));
        const failed = execution.status !== 0 || Boolean(execution.error)
          || /\[x\]/i.test(output) || (patch.optional && findings.length > 0);
        result.exitCode = execution.status;
        result.signal = execution.signal;
        result.notices = output.split(/\r?\n/).filter((line) =>
          /\[skip\]|\[!\]|no match|not found|no .*targets? found|no .*bundles? found/i.test(line),
        );
        result.status = failed ? (required || strict ? "failed" : "warning") : "passed";
        result.diagnostic = failed ? (findings.join("\n") || output).slice(-8000) || "补丁进程未正常完成。" : "补丁脚本已完成。";
        if (reportDir) {
          result.logFile = `logs/${item}-${patch.script}.log`;
          fs.writeFileSync(path.join(reportDir, result.logFile), output);
        }
        if (failed && patch.optional && !check) {
          restoreFiles(snapshot);
          result.restored = true;
        }
      } catch (error) {
        result.status = "failed";
        result.diagnostic = error.message;
        if (snapshot?.length) {
          try { restoreFiles(snapshot); result.restored = true; }
          catch (restoreError) { result.diagnostic += `; rollback failed: ${restoreError.message}`; }
        }
      }
      if (result.status !== "passed") {
        const level = result.status === "warning" ? "warning" : "error";
        log(`[${level}] ${item}/${patch.script}: ${result.status === "warning" ? "keeping upstream implementation" : "build blocked"}`);
        if (process.env.GITHUB_ACTIONS === "true") {
          log(`::${level} title=${patch.script}::${item}: ${patch.feature} ${result.status === "warning" ? "保留上游实现，详见兼容报告" : "失败，构建停止，详见兼容报告"}`);
        }
      }
      report.results.push(result);
    }
  }
  report.canBuild = report.errors.length === 0 && !report.results.some((item) => item.status === "failed");
  log(`\n== Summary: ${report.results.filter((item) => item.status === "passed").length} passed, ${report.results.filter((item) => item.status === "warning").length} optional warnings, ${report.results.filter((item) => item.status === "failed").length} failures ==`);
  for (const error of report.errors) log(`[error] ${error}`);
  saveReport(report, reportDir);
  return report;
}

if (require.main === module) {
  try {
    const report = runPatches(parseArgs(process.argv.slice(2)));
    if (!report.canBuild) process.exitCode = 1;
  } catch (error) {
    console.error(`[error] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, runPatches, renderReport };
