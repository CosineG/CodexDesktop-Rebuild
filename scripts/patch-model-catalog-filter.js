#!/usr/bin/env node
/**
 * 构建后补丁：模型目录仅按 hidden 字段过滤，不依赖服务端 availableModels allowlist。
 *
 * 已知网关形状（TEST ? <allowlist 分支> : !X.hidden）：
 *   - consequent 为裸的 `<set>.has(X.model)` 调用（如 execution bundle）；
 *   - consequent 为包含该调用的顶层逻辑表达式（如 26.1002 app-initial 的
 *     `r.has(o.model)||其他放行条件`）。
 * 成员测试须位于 consequent 顶层逻辑链，深层嵌套（回调、成员链等）不视为网关。
 * 既无成员测试也无 `?!X.hidden` 网关签名的 bundle（如 content bundle 仅含调用点）
 * 按无网关跳过；存在任一信号却无法识别网关结构时仍显式报错，避免上游变更后被静默放过。
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

/** 识别 allowlist 成员测试 `<set>.has(<X>.model)`，返回 `<X>` 所在节点。 */
function membershipModelObject(node) {
  if (node?.type !== "CallExpression") return null;
  if (memberPropertyName(node.callee) !== "has") return null;
  if (node.arguments.length !== 1) return null;
  if (memberPropertyName(node.arguments[0]) !== "model") return null;
  return node.arguments[0].object;
}

/** 判定三元表达式的 alternate 是否为 `!X.hidden` 形态的网关签名。 */
function hasHiddenFallback(node) {
  return (
    node.type === "ConditionalExpression" &&
    node.alternate.type === "UnaryExpression" &&
    node.alternate.operator === "!" &&
    memberPropertyName(node.alternate.argument) === "hidden"
  );
}

/** 在 consequent 及其顶层 ||/&& 链直接操作数中查找针对指定 model 对象的成员测试。 */
function findDirectMembership(node, source, modelSource) {
  if (node?.type === "LogicalExpression") {
    return (
      findDirectMembership(node.left, source, modelSource) ||
      findDirectMembership(node.right, source, modelSource)
    );
  }
  const object = membershipModelObject(node);
  if (object && source.slice(object.start, object.end) === modelSource) {
    return node;
  }
  return null;
}

function matchAllowlistConditional(node, source) {
  if (!hasHiddenFallback(node)) return null;

  const hiddenFallback = node.alternate;
  const modelSource = source.slice(
    hiddenFallback.argument.object.start,
    hiddenFallback.argument.object.end,
  );

  // consequent 顶层逻辑链须存在针对同一 model 对象的 allowlist 成员测试
  if (!findDirectMembership(node.consequent, source, modelSource)) return null;

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
  let membershipCount = 0;
  let gateSignatureCount = 0;
  walk(ast, (node) => {
    if (membershipModelObject(node)) membershipCount++;
    if (hasHiddenFallback(node)) gateSignatureCount++;
    const patch = matchAllowlistConditional(node, source);
    if (!patch) return;
    // 丢弃嵌套在其他已匹配网关内部的重复匹配，避免改写区间重叠
    if (patches.some((p) => node.start >= p.start && node.end <= p.end)) return;
    patches.push(patch);
  });

  if (patches.length === 0) {
    if (source.includes(MARKER)) {
      return { status: "already-patched", source, patches: [] };
    }
    if (membershipCount === 0 && gateSignatureCount === 0) {
      // 无成员测试亦无 `?!X.hidden` 网关签名（如 content bundle 仅含调用点），确无网关可处理
      return { status: "no-allowlist-gate", source, patches: [] };
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
        source.includes(".hidden")
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
    if (result.status === "no-allowlist-gate") {
      console.log(`  [ok] ${label}: no allowlist gate (call-site only)`);
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
