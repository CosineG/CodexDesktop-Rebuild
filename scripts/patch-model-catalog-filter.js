#!/usr/bin/env node
/**
 * 构建后补丁：模型目录仅按 hidden 字段过滤，不依赖服务端 availableModels allowlist。
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { listJavaScriptFiles, SRC_DIR, relPath } = require("./patch-util");

const MARKER = "/* Codex：模型目录忽略服务端 allowlist。 */";

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) walk(item, visitor);
    } else {
      walk(child, visitor);
    }
  }
}

function memberPropertyName(node) {
  if (node?.type !== "MemberExpression") return null;
  if (!node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }
  if (node.computed && node.property.type === "Literal") {
    return node.property.value;
  }
  return null;
}

function matchAllowlistConditional(node, source) {
  if (node.type !== "ConditionalExpression") return null;

  // 新版在 allowlist 后增加了 API-key 访问计划分支，仍以同一个 hidden 回退收口。
  let allowlistCall = node.consequent;
  while (allowlistCall.type === "LogicalExpression" && allowlistCall.operator === "||") {
    allowlistCall = allowlistCall.left;
  }
  const hiddenFallback = node.alternate;
  if (
    allowlistCall.type !== "CallExpression" ||
    memberPropertyName(allowlistCall.callee) !== "has" ||
    allowlistCall.arguments.length !== 1 ||
    memberPropertyName(allowlistCall.arguments[0]) !== "model" ||
    hiddenFallback.type !== "UnaryExpression" ||
    hiddenFallback.operator !== "!" ||
    memberPropertyName(hiddenFallback.argument) !== "hidden"
  ) {
    return null;
  }

  const modelFromAllowlist = allowlistCall.arguments[0].object;
  const modelFromHidden = hiddenFallback.argument.object;
  if (
    source.slice(modelFromAllowlist.start, modelFromAllowlist.end) !==
    source.slice(modelFromHidden.start, modelFromHidden.end)
  ) {
    return null;
  }

  return {
    start: node.start,
    end: node.end,
    original: source.slice(node.start, node.end),
    replacement: `${MARKER}${source.slice(hiddenFallback.start, hiddenFallback.end)}`,
  };
}

function patchSource(source) {
  let ast;
  try {
    ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch (error) {
    return { status: "parse-error", source, error, patches: [] };
  }

  const patches = [];
  walk(ast, (node) => {
    const patch = matchAllowlistConditional(node, source);
    if (patch) patches.push(patch);
  });

  if (patches.length === 0) {
    if (source.includes(MARKER)) {
      return { status: "already-patched", source, patches: [] };
    }
    return {
      status: "unexpected-anchor-count",
      count: 0,
      source,
      patches,
    };
  }

  let next = source;
  for (const patch of patches.sort((left, right) => right.start - left.start)) {
    next =
      next.slice(0, patch.start) + patch.replacement + next.slice(patch.end);
  }
  try {
    parse(next, { ecmaVersion: "latest", sourceType: "module" });
  } catch (error) {
    return { status: "invalid-output", source, error, patches };
  }

  return { status: "patched", source: next, patches };
}

function getPlatforms(platform, srcDir) {
  if (platform) return [platform];
  return ["mac-arm64", "mac-x64", "win"].filter((item) =>
    fs.existsSync(path.join(srcDir, item, "_asar", "webview", "assets")),
  );
}

/**
 * 定位模型目录补丁目标。
 * 预筛命中但无法改写（或已不是 allowlist 条件）的候选进入 dropped，交由入口明确报错。
 * @param {string} [platform] 限定平台；省略时扫描全部可用平台
 * @param {{ srcDir?: string }} [options] srcDir 供回归测试使用独立目录
 * @returns {{ targets: Array<{platform: string, path: string, result: object}>, dropped: Array<{platform: string, path: string, status: string, count?: number}> }}
 */
function findTargets(platform, { srcDir = SRC_DIR } = {}) {
  const targets = [];
  const dropped = [];
  for (const currentPlatform of getPlatforms(platform, srcDir)) {
    const assetsDir = path.join(
      srcDir,
      currentPlatform,
      "_asar",
      "webview",
      "assets",
    );

    // 递归扫描 assets，兼容上游把界面 chunk 移入 async 目录。
    for (const file of listJavaScriptFiles(assetsDir)) {
      const filePath = path.join(assetsDir, file);
      const source = fs.readFileSync(filePath, "utf-8");
      // 预筛：已打标记，或存在模型成员的 allowlist 判断；仅调用公共过滤器的 chunk 不是目标。
      const candidate = source.includes(MARKER) ||
        (source.includes("availableModels") &&
          source.includes("useHiddenModels") &&
          source.includes(".hidden") &&
          /\.has\([\w$]+\.model\)/.test(source));
      if (!candidate) continue;
      // 只有能真正改写（或已改写）的 chunk 才算目标，避免仅提及字段的调用方报错。
      const result = patchSource(source);
      if (result.status === "patched" || result.status === "already-patched") {
        targets.push({ platform: currentPlatform, path: filePath, result });
      } else {
        // 通过预筛却不再匹配 allowlist 条件，说明上游结构已漂移，必须让构建失败。
        dropped.push({
          platform: currentPlatform,
          path: filePath,
          status: result.status,
          ...(result.count == null ? {} : { count: result.count }),
        });
      }
    }
  }
  return { targets, dropped };
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((item) =>
    ["mac-arm64", "mac-x64", "win"].includes(item),
  );
  const { targets, dropped } = findTargets(platform);

  for (const item of dropped) {
    console.log(
      `  [!] ${relPath(item.path)}: ${item.status}（候选已不再匹配 allowlist 条件）`,
    );
  }

  if (targets.length === 0) {
    if (dropped.length > 0) {
      console.log(
        `  [x] No patchable model catalog allowlist gate found (${dropped.length} candidate(s) rejected)`,
      );
      process.exitCode = 1;
      return;
    }
    console.log("  [skip] No model catalog filter bundle found");
    return;
  }

  let changed = 0;
  for (const target of targets) {
    const label = relPath(target.path);
    const result = target.result;
    if (result.status === "already-patched") {
      console.log(`  [ok] ${label}: already patched`);
      continue;
    }

    if (isCheck) {
      console.log(
        `  [?] ${label}: would ignore ${result.patches.length} availableModels allowlist gate(s)`,
      );
    } else {
      fs.writeFileSync(target.path, result.source, "utf-8");
      console.log(
        `  [ok] ${label}: ignored ${result.patches.length} availableModels allowlist gate(s)`,
      );
    }
    changed++;
  }

  console.log(
    `  [done] ${isCheck ? "would patch" : "patched"} ${changed} file(s)`,
  );
}

if (require.main === module) main();

module.exports = { MARKER, findTargets, patchSource };
