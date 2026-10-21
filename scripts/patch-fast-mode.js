#!/usr/bin/env node
/**
 * 构建后补丁：为 API key 登录启用 Fast mode（速度选择器）。
 *
 * 上游会用 authMethod 或保存认证结果的局部变量限制速度选择器及
 * service_tier 读取。补丁覆盖以下两类判断，并且只额外放行 apikey：
 *   X !== "chatgpt"  -> X !== "chatgpt" && X !== "apikey"
 *   X === "chatgpt"  -> X === "chatgpt" || X === "apikey"
 *
 * 目标：fast_mode 权限函数、新版 readServiceTier 的账户回调，
 * 以及界面侧返回 serviceTierAccess 的认证与加载状态判断。
 * 必须匹配完整字段名，避免把 codex_fast_mode 首页提示中的产品类型当作认证。
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { locateBundles, relPath, SRC_DIR } = require("./patch-util");

function walk(node, visitor, parent = null) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node, parent);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && item.type)
          walk(item, visitor, node);
      }
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitor, node);
    }
  }
}

function isChatGptLiteral(node) {
  return (
    (node.type === "Literal" && node.value === "chatgpt") ||
    (node.type === "TemplateLiteral" &&
      node.expressions.length === 0 &&
      node.quasis.length === 1 &&
      node.quasis[0].value.cooked === "chatgpt")
  );
}

function expressionSourceForApiKeySide(binary, source) {
  if (isChatGptLiteral(binary.right)) return source.slice(binary.left.start, binary.left.end);
  if (isChatGptLiteral(binary.left)) return source.slice(binary.right.start, binary.right.end);
  return null;
}

function isAlreadyExpandedToApiKey(parent, source) {
  if (!parent || parent.type !== "LogicalExpression") return false;
  return source.slice(parent.start, parent.end).includes("apikey");
}

function hasServiceTierAccessResult(node) {
  let found = false;
  walk(node, (child) => {
    // 调用方也会解构同名字段，只接受权限函数实际构造的结果对象。
    if (child.type !== "ObjectExpression") return;
    const keys = child.properties
      .filter((property) => property.type === "Property" && !property.computed)
      .map((property) => property.key.name ?? property.key.value);
    if (keys.includes("serviceTierAccess") && keys.includes("isLoading")) found = true;
  });
  return found;
}

function isFastModeFunction(source, node = null) {
  return /\bfast_mode\b/.test(source) ||
    (source.includes("readServiceTier") && source.includes("getAccount")) ||
    (source.includes("serviceTierAccess") &&
      source.includes("authMethod") && source.includes("isLoading") &&
      (node == null || hasServiceTierAccessResult(node)));
}

function collectPatches(ast, source) {
  const patches = [];

  walk(ast, (node) => {
    // 覆盖后端读取和界面速度权限，避免误伤普通产品类型比较。
    const isFn =
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression";
    if (!isFn) return;

    const fnSrc = source.slice(node.start, node.end);
    if (!isFastModeFunction(fnSrc, node) || !fnSrc.includes("chatgpt")) return;

    walk(node, (child, parent) => {
      if (child.type !== "BinaryExpression") return;

      const childSrc = source.slice(child.start, child.end);

      // 旧版和新版都可能先把 authMethod 保存到局部变量再进行排除判断。
      if (child.operator === "!==") {
        const apiKeySide = expressionSourceForApiKeySide(child, source);
        if (apiKeySide == null) return;
        if (isAlreadyExpandedToApiKey(parent, source)) return;

        // 同一函数可能被外层函数再次遍历，按偏移去重。
        if (patches.some((p) => p.start === child.start)) return;

        patches.push({
          id: "fast_mode_auth_gate",
          start: child.start,
          end: child.end,
          replacement: `(${childSrc}&&${apiKeySide}!==\`apikey\`)`,
          original: childSrc,
        });
        return;
      }

      // 肯定判断同样只额外允许 API key 登录。
      if (child.operator === "===") {
        const apiKeySide = expressionSourceForApiKeySide(child, source);
        if (apiKeySide == null) return;
        if (isAlreadyExpandedToApiKey(parent, source)) return;

        // 同一函数可能被外层函数再次遍历，按偏移去重。
        if (patches.some((p) => p.start === child.start)) return;

        patches.push({
          id: "fast_mode_api_auth_gate",
          start: child.start,
          end: child.end,
          replacement: `(${childSrc}||${apiKeySide}===\`apikey\`)`,
          original: childSrc,
        });
      }
    });
  });

  return patches;
}

function hasPatchedFastModeGate(ast, source) {
  let found = false;
  walk(ast, (node) => {
    if (found) return;
    const isFn =
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression";
    if (!isFn) return;

    const fnSource = source.slice(node.start, node.end);
    if (!isFastModeFunction(fnSource, node) || !fnSource.includes("chatgpt")) return;
    walk(node, (child, parent) => {
      if (
        child.type === "BinaryExpression" &&
        expressionSourceForApiKeySide(child, source) != null &&
        isAlreadyExpandedToApiKey(parent, source)
      ) {
        found = true;
      }
    });
  });
  return found;
}

function patchSource(source) {
  if (!isFastModeFunction(source) || !source.includes("chatgpt")) {
    return { status: "not-applicable", source, patches: [] };
  }

  let ast;
  try {
    ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch (error) {
    return { status: "parse-error", source, error };
  }

  const patches = collectPatches(ast, source).sort((a, b) => b.start - a.start);
  if (patches.length === 0) {
    return {
      status: hasPatchedFastModeGate(ast, source)
        ? "already-patched"
        : "not-applicable",
      source,
      patches: [],
    };
  }

  let code = source;
  for (const patch of patches) {
    code = code.slice(0, patch.start) + patch.replacement + code.slice(patch.end);
  }

  // 写回前重新解析，避免生成损坏的压缩代码。
  try {
    parse(code, { ecmaVersion: "latest", sourceType: "module" });
  } catch (error) {
    return { status: "invalid-output", source, patches, error };
  }

  return { status: "patched", source: code, patches };
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) =>
    ["mac-arm64", "mac-x64", "win"].includes(a),
  );

  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((p) =>
        fs.existsSync(path.join(SRC_DIR, p, "_asar", "webview", "assets")),
      );

  const targets = [];
  for (const plat of platforms) {
    const assetsDir = path.join(SRC_DIR, plat, "_asar", "webview", "assets");
    if (!fs.existsSync(assetsDir)) continue;
    for (const f of fs.readdirSync(assetsDir)) {
      if (!f.endsWith(".js")) continue;
      const fp = path.join(assetsDir, f);
      const src = fs.readFileSync(fp, "utf-8");
      if (src.includes("chatgpt") && isFastModeFunction(src)) {
        targets.push({ platform: plat, path: fp });
      }
    }
  }

  if (targets.length === 0) {
    console.log("  [skip] No chunk contains fast_mode gate logic");
    return;
  }

  let totalPatched = 0;
  let totalFound = 0;
  let failed = 0;
  const relevantPlatforms = new Set();

  for (const bundle of targets) {
    const source = fs.readFileSync(bundle.path, "utf-8");

    const t0 = Date.now();
    const result = patchSource(source);
    if (result.status === "parse-error") {
      console.log(`  [x] ${relPath(bundle.path)}: parse failed`);
      failed++;
      continue;
    }
    if (result.status === "already-patched") {
      relevantPlatforms.add(bundle.platform);
      continue;
    }
    if (result.status === "invalid-output") {
      console.log(`  [x] ${relPath(bundle.path)}: patched output is invalid`);
      failed++;
      continue;
    }

    const patches = result.patches;

    if (patches.length === 0) continue;
    relevantPlatforms.add(bundle.platform);
    totalFound += patches.length;

    console.log(
      `  [${bundle.platform}] ${relPath(bundle.path)} (parse ${Date.now() - t0}ms)`,
    );

    if (isCheck) {
      for (const p of patches) {
        console.log(`    [?] offset ${p.start}: ${p.original} -> ${p.replacement}`);
      }
      continue;
    }

    for (const p of patches) {
      console.log(`    * ${p.original} -> ${p.replacement}`);
    }

    fs.writeFileSync(bundle.path, result.source, "utf-8");
    totalPatched += patches.length;
  }

  if (totalPatched > 0) {
    console.log(`  [ok] ${totalPatched} auth gate(s) removed`);
  } else if (isCheck && totalFound > 0) {
    console.log(`  [check] ${totalFound} auth gate(s) would be patched`);
  } else {
    console.log("  [ok] fast_mode auth gates already patched or absent");
  }

  for (const currentPlatform of platforms) {
    if (!relevantPlatforms.has(currentPlatform)) {
      console.log(`  [x] [${currentPlatform}] no recognized fast_mode auth gate`);
      failed++;
    }
  }
  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { collectPatches, patchSource };
