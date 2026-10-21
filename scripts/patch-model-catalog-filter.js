#!/usr/bin/env node
/**
 * 构建后补丁：模型目录仅按 hidden 字段过滤，不依赖服务端 availableModels allowlist。
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { SRC_DIR, relPath } = require("./patch-util");

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

function getPlatforms(platform) {
  if (platform) return [platform];
  return ["mac-arm64", "mac-x64", "win"].filter((item) =>
    fs.existsSync(path.join(SRC_DIR, item, "_asar", "webview", "assets")),
  );
}

function findTargets(platform) {
  const targets = [];
  for (const currentPlatform of getPlatforms(platform)) {
    const assetsDir = path.join(
      SRC_DIR,
      currentPlatform,
      "_asar",
      "webview",
      "assets",
    );
    if (!fs.existsSync(assetsDir)) continue;

    for (const file of fs.readdirSync(assetsDir)) {
      if (!file.endsWith(".js")) continue;
      const filePath = path.join(assetsDir, file);
      const source = fs.readFileSync(filePath, "utf-8");
      if (
        source.includes("availableModels") &&
        source.includes("useHiddenModels") &&
        source.includes(".hidden") &&
        // 仅调用公共过滤器的 chunk 不是补丁目标；必须存在模型成员的 allowlist 判断。
        (/\.has\([\w$]+\.model\)/.test(source) || source.includes(MARKER))
      ) {
        targets.push({ platform: currentPlatform, path: filePath, source });
      }
    }
  }
  return targets;
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((item) =>
    ["mac-arm64", "mac-x64", "win"].includes(item),
  );
  const targets = findTargets(platform);

  if (targets.length === 0) {
    console.log("  [skip] No model catalog filter bundle found");
    return;
  }

  let changed = 0;
  let failed = 0;
  for (const target of targets) {
    const label = relPath(target.path);
    const result = patchSource(target.source);
    if (result.status === "already-patched") {
      console.log(`  [ok] ${label}: already patched`);
      continue;
    }
    if (result.status !== "patched") {
      console.log(
        `  [x] ${label}: ${result.status}` +
          (result.count == null ? "" : ` (anchors: ${result.count})`),
      );
      failed++;
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
  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { MARKER, findTargets, patchSource };
