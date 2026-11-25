/**
 * Post-build patch: Force-enable i18n by bypassing Statsig cloud control
 *
 * Codex i18n is gated behind a Statsig layer field "enable_i18n".
 * The Statsig server can push enable_i18n=false to override the default.
 *
 * AST match: any .get("enable_i18n", <default>) call expression
 * (optionally wrapped in ChainExpression for ?.get), replaced with !0.
 *
 * Target files: 递归扫描 webview/assets（含 async 分片），只处理源码含 "enable_i18n" 的 chunk。
 *
 * Usage:
 *   node scripts/patch-i18n.js [platform]   # Apply (mac-arm64/mac-x64/win/omit=all)
 *   node scripts/patch-i18n.js --check      # Dry-run
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { listJavaScriptFiles, relPath, SRC_DIR } = require("./patch-util");

// ──────────────────────────────────────────────
//  AST walker
// ──────────────────────────────────────────────

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && item.type) walk(item, visitor);
      }
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitor);
    }
  }
}

// ──────────────────────────────────────────────
//  AST matching
// ──────────────────────────────────────────────

const FIELD_NAME = "enable_i18n";
// 替换值自带标记：重复执行时才能区分“本补丁已启用”和“上游已移除闸门”。
const PATCH_MARKER = "!0/*codex-i18n-enabled*/";

/**
 * Find CallExpression (possibly wrapped in ChainExpression):
 *   X?.get("enable_i18n", <default>)
 *   X.get("enable_i18n", <default>)
 *
 * AST structural match — no hardcoded layer ID. The .get("enable_i18n", ...)
 * pattern on a MemberExpression is unique enough.
 *
 * Replace the outermost expression (ChainExpression or CallExpression) with !0.
 */
function collectPatches(ast, source) {
  const patches = [];
  const seen = new Set();

  walk(ast, (node) => {
    let callNode = null;
    let replaceNode = null;

    // Match ChainExpression wrapping a CallExpression
    if (node.type === "ChainExpression" && node.expression?.type === "CallExpression") {
      callNode = node.expression;
      replaceNode = node;
    } else if (node.type === "CallExpression") {
      callNode = node;
      replaceNode = node;
    }

    if (!callNode) return;

    // Callee must be MemberExpression with property "get"
    const callee = callNode.callee;
    if (!callee || callee.type !== "MemberExpression") return;
    const prop = callee.property;
    if (!prop) return;
    const propName = prop.type === "Identifier" ? prop.name
      : prop.type === "Literal" ? prop.value : null;
    if (propName !== "get") return;

    // First argument must be string literal "enable_i18n"
    const args = callNode.arguments;
    if (!args || args.length < 2) return;
    const firstArg = args[0];
    const argValue = firstArg.type === "Literal" ? firstArg.value
      : (firstArg.type === "TemplateLiteral" && firstArg.expressions.length === 0
        && firstArg.quasis.length === 1) ? firstArg.quasis[0].value.cooked
      : null;
    if (argValue !== FIELD_NAME) return;

    // Already patched?
    const exprSrc = source.slice(replaceNode.start, replaceNode.end);
    if (exprSrc === "!0" || exprSrc === PATCH_MARKER) return;

    // Dedup
    if (seen.has(replaceNode.start)) return;
    seen.add(replaceNode.start);

    patches.push({
      start: replaceNode.start,
      end: replaceNode.end,
      replacement: PATCH_MARKER,
      original: exprSrc,
    });
  });

  return patches;
}

// ──────────────────────────────────────────────
//  Bundle location: scan all JS chunks for enable_i18n
// ──────────────────────────────────────────────

function locateTargets(platform, { srcDir = SRC_DIR } = {}) {
  const assetsFor = (plat) => path.join(srcDir, plat, "_asar", "webview", "assets");
  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((p) => fs.existsSync(assetsFor(p)));

  const targets = [];
  for (const plat of platforms) {
    const assetsDir = assetsFor(plat);
    for (const file of listJavaScriptFiles(assetsDir)) {
      const filePath = path.join(assetsDir, file);
      const source = fs.readFileSync(filePath, "utf-8");
      if (source.includes(FIELD_NAME)) {
        // 仍有闸门调用，需要（继续）补丁。
        targets.push({ platform: plat, path: filePath, patched: false });
      } else if (source.includes(PATCH_MARKER)) {
        // 闸门字符串已消失但留下补丁标记：说明此前已启用，而不是上游移除。
        targets.push({ platform: plat, path: filePath, patched: true });
      }
    }
  }

  return targets;
}

// ──────────────────────────────────────────────
//  Main
// ──────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));

  const targets = locateTargets(platform);

  if (targets.length === 0) {
    console.log("[ok] No files contain enable_i18n (upstream may have removed gate)");
    return;
  }

  let grandTotal = 0;

  for (const bundle of targets) {
    console.log(`\n-- [${bundle.platform}] ${relPath(bundle.path)}`);
    if (bundle.patched) {
      console.log("   [ok] i18n gate already enabled");
      continue;
    }
    const source = fs.readFileSync(bundle.path, "utf-8");
    console.log(`   size: ${(source.length / 1024 / 1024).toFixed(1)} MB`);

    const t0 = Date.now();
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    console.log(`   parse: ${Date.now() - t0}ms`);

    const patches = collectPatches(ast, source);
    grandTotal += patches.length;

    if (patches.length === 0) {
      console.log("   [ok] enable_i18n already bypassed or no AST match");
      continue;
    }

    if (isCheck) {
      console.log(`   [?] Matches: ${patches.length}`);
      for (const p of patches) {
        console.log(`     > offset ${p.start}: ${p.original.slice(0, 60)} -> !0`);
      }
      continue;
    }

    patches.sort((a, b) => b.start - a.start);

    let code = source;
    for (const p of patches) {
      console.log(`   * offset ${p.start}: ${p.original.slice(0, 60)} -> !0`);
      code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
    }

    fs.writeFileSync(bundle.path, code, "utf-8");
    console.log(`   [ok] i18n gate bypassed: ${patches.length} replacements`);
  }

  if (isCheck && grandTotal > 0) {
    console.log(`\n=> Total: ${grandTotal} patchable locations`);
  }
}

module.exports = { PATCH_MARKER, main, locateTargets, collectPatches };

if (require.main === module) main();
