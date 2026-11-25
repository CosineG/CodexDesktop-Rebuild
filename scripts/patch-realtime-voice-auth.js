#!/usr/bin/env node
/**
 * 构建后补丁：为 API key 登录启用实时语音入口。
 *
 * 上游实时会话核心支持 API key，并使用当前 model provider 创建 WebRTC
 * 会话；桌面端权限层却只允许 chatgpt 认证。这里只扩展语音权限函数：
 *   X !== "chatgpt" -> X !== "chatgpt" && X !== "apikey"
 *
 * Work Cloud、Copilot 和其他账户能力的认证判断保持不变。
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { listJavaScriptFiles, relPath, SRC_DIR } = require("./patch-util");

const PLATFORM_NAMES = ["mac-arm64", "mac-x64", "win"];

function walk(node, visitor, parent = null, ancestors = []) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node, parent, ancestors);

  const nextAncestors = node.type ? [...ancestors, node] : ancestors;
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && item.type) {
          walk(item, visitor, node, nextAncestors);
        }
      }
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitor, node, nextAncestors);
    }
  }
}

function isFunction(node) {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

function isStringLiteral(node, value) {
  return (
    (node.type === "Literal" && node.value === value) ||
    (node.type === "TemplateLiteral" &&
      node.expressions.length === 0 &&
      node.quasis.length === 1 &&
      node.quasis[0].value.cooked === value)
  );
}

function expressionComparedWithChatGpt(binary, source) {
  if (isStringLiteral(binary.right, "chatgpt")) {
    return source.slice(binary.left.start, binary.left.end);
  }
  if (isStringLiteral(binary.left, "chatgpt")) {
    return source.slice(binary.right.start, binary.right.end);
  }
  return null;
}

function hasVoiceFunctionMarkers(functionSource) {
  return (
    functionSource.includes("permissions") &&
    functionSource.includes("unsupported-auth") &&
    (functionSource.includes("freeAndGoPlansAllowed") ||
      functionSource.includes("freePlanAllowed"))
  );
}

function enclosingUnsupportedAuthConditional(node, ancestors, source) {
  for (let index = ancestors.length - 1; index >= 0; index--) {
    const ancestor = ancestors[index];
    if (ancestor.type !== "ConditionalExpression") continue;
    if (node.start < ancestor.test.start || node.end > ancestor.test.end) continue;

    const testSource = source.slice(ancestor.test.start, ancestor.test.end);
    const deniedSource = source.slice(
      ancestor.consequent.start,
      ancestor.consequent.end,
    );
    if (
      testSource.includes("allowed") &&
      deniedSource.includes("denied") &&
      deniedSource.includes("unsupported-auth")
    ) {
      return ancestor;
    }
  }
  return null;
}

function parentAlreadyAllowsApiKey(parent, source) {
  return (
    parent?.type === "LogicalExpression" &&
    source.slice(parent.start, parent.end).includes("apikey")
  );
}

function collectPatches(ast, source) {
  const patches = [];

  walk(ast, (node) => {
    if (!isFunction(node)) return;
    const functionSource = source.slice(node.start, node.end);
    if (!hasVoiceFunctionMarkers(functionSource)) return;

    walk(node, (child, parent, ancestors) => {
      if (child.type !== "BinaryExpression" || child.operator !== "!==") return;

      const authExpression = expressionComparedWithChatGpt(child, source);
      if (authExpression == null) return;
      if (parentAlreadyAllowsApiKey(parent, source)) return;
      if (!enclosingUnsupportedAuthConditional(child, ancestors, source)) return;
      if (patches.some((patch) => patch.start === child.start)) return;

      const original = source.slice(child.start, child.end);
      patches.push({
        id: "realtime_voice_auth_gate",
        start: child.start,
        end: child.end,
        original,
        replacement: `${original}&&${authExpression}!==\`apikey\``,
      });
    });
  });

  return patches;
}

function hasPatchedVoiceGate(ast, source) {
  let found = false;

  walk(ast, (node) => {
    if (found || !isFunction(node)) return;
    const functionSource = source.slice(node.start, node.end);
    if (!hasVoiceFunctionMarkers(functionSource)) return;

    walk(node, (child, parent, ancestors) => {
      if (found) return;
      if (child.type !== "BinaryExpression" || child.operator !== "!==") return;
      if (expressionComparedWithChatGpt(child, source) == null) return;
      if (!parentAlreadyAllowsApiKey(parent, source)) return;
      if (!enclosingUnsupportedAuthConditional(child, ancestors, source)) return;
      found = true;
    });
  });

  return found;
}

function patchSource(source) {
  if (
    !source.includes("chatgpt") ||
    !source.includes("unsupported-auth") ||
    (!source.includes("freeAndGoPlansAllowed") &&
      !source.includes("freePlanAllowed"))
  ) {
    return { status: "not-applicable", source, patches: [] };
  }

  let ast;
  try {
    ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch (error) {
    return { status: "parse-error", source, patches: [], error };
  }

  const patches = collectPatches(ast, source).sort((a, b) => b.start - a.start);
  if (patches.length === 0) {
    return {
      status: hasPatchedVoiceGate(ast, source)
        ? "already-patched"
        : "not-applicable",
      source,
      patches: [],
    };
  }

  let patchedSource = source;
  for (const patch of patches) {
    patchedSource =
      patchedSource.slice(0, patch.start) +
      patch.replacement +
      patchedSource.slice(patch.end);
  }

  try {
    parse(patchedSource, { ecmaVersion: "latest", sourceType: "module" });
  } catch (error) {
    return {
      status: "invalid-output",
      source,
      patches,
      error,
    };
  }

  return { status: "patched", source: patchedSource, patches };
}

function findTargets(platforms) {
  const targets = [];
  for (const platform of platforms) {
    const assetsDir = path.join(
      SRC_DIR,
      platform,
      "_asar",
      "webview",
      "assets",
    );

    // 递归扫描 assets，兼容上游把界面 chunk 移入 async 目录。
    for (const file of listJavaScriptFiles(assetsDir)) {
      const filePath = path.join(assetsDir, file);
      const source = fs.readFileSync(filePath, "utf8");
      if (
        source.includes("unsupported-auth") &&
        source.includes("chatgpt") &&
        (source.includes("freeAndGoPlansAllowed") ||
          source.includes("freePlanAllowed"))
      ) {
        targets.push({ platform, path: filePath });
      }
    }
  }
  return targets;
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((arg) => PLATFORM_NAMES.includes(arg));
  const platforms = platform
    ? [platform]
    : PLATFORM_NAMES.filter((name) =>
        fs.existsSync(path.join(SRC_DIR, name, "_asar", "webview", "assets")),
      );
  const targets = findTargets(platforms);

  if (targets.length === 0) {
    console.log("  [skip] No chunk contains realtime voice auth gate logic");
    return;
  }

  let failed = 0;
  let totalFound = 0;
  let totalPatched = 0;
  const relevantPlatforms = new Set();

  for (const target of targets) {
    const source = fs.readFileSync(target.path, "utf8");
    const startedAt = Date.now();
    const result = patchSource(source);

    if (result.status === "parse-error") {
      console.log(`  [x] ${relPath(target.path)}: parse failed`);
      failed++;
      continue;
    }
    if (result.status === "invalid-output") {
      console.log(`  [x] ${relPath(target.path)}: patched output is invalid`);
      failed++;
      continue;
    }
    if (result.status === "already-patched") {
      relevantPlatforms.add(target.platform);
      continue;
    }
    if (result.status === "not-applicable") continue;

    relevantPlatforms.add(target.platform);
    totalFound += result.patches.length;
    console.log(
      `  [${target.platform}] ${relPath(target.path)} (parse ${Date.now() - startedAt}ms)`,
    );

    if (isCheck) {
      for (const patch of result.patches) {
        console.log(
          `    [?] offset ${patch.start}: ${patch.original} -> ${patch.replacement}`,
        );
      }
      continue;
    }

    for (const patch of result.patches) {
      console.log(`    * ${patch.original} -> ${patch.replacement}`);
    }
    fs.writeFileSync(target.path, result.source, "utf8");
    totalPatched += result.patches.length;
  }

  if (totalPatched > 0) {
    console.log(`  [ok] ${totalPatched} realtime voice auth gate(s) expanded`);
  } else if (isCheck && totalFound > 0) {
    console.log(`  [check] ${totalFound} realtime voice auth gate(s) would be patched`);
  } else {
    console.log("  [ok] realtime voice auth gates already patched or absent");
  }

  for (const currentPlatform of platforms) {
    if (!relevantPlatforms.has(currentPlatform)) {
      console.log(
        `  [x] [${currentPlatform}] no recognized realtime voice auth gate`,
      );
      failed++;
    }
  }
  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  collectPatches,
  hasPatchedVoiceGate,
  patchSource,
};
