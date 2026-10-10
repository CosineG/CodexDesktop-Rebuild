#!/usr/bin/env node
/**
 * 兼容 API-key 登录下的 Browser / Chrome 本地通道。
 *
 * 新版 browser-service 会在扩展命令前读取
 * `codex_browser_use_agent_request_header`。读取过程依赖 ChatGPT 身份接口，
 * 而 node_repl 对 `apikey` 认证会直接抛出：
 * `unsupported Codex auth method: apikey`。
 *
 * 这里保留 ChatGPT 登录下的原有身份与 Statsig 流程；仅当该流程失败时，
 * 将 request-header 能力降级为关闭，恢复旧版可继续建立本地浏览器通道的行为。
 * 26.1007 将读取改为调用通用 feature-gate 函数；仅包装 request-header
 * 回调，不改变其他 feature gate 的身份要求或超时逻辑。
 * 不会把 API key 当作 ChatGPT token 发送到 chatgpt.com。
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { SRC_DIR, relPath } = require("./patch-util");

const IDENTITY_ERROR =
  "Browser request-header policy requires caller identity.";
const FEATURE_GATE_IDENTITY_ERROR = "Browser feature gates require caller identity.";
const REQUEST_HEADER_GATE = "codex_browser_use_agent_request_header";

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node);
  for (const [key, child] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && item.type) walk(item, visitor);
      }
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitor);
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

function returnsFalse(node) {
  return (
    node?.type === "ReturnStatement" &&
    node.argument?.type === "UnaryExpression" &&
    node.argument.operator === "!" &&
    node.argument.argument?.type === "Literal" &&
    node.argument.argument.value === 1
  );
}

function hasFallbackCatch(fn) {
  let found = false;
  walk(fn.body, (node) => {
    if (node.type !== "CatchClause") return;
    if (node.body?.body?.some(returnsFalse)) found = true;
  });
  return found;
}

function findRequestHeaderAuthPatches(ast, source) {
  const patches = [];

  walk(ast, (node) => {
    if (!isFunction(node) || !node.async) return;
    if (node.body?.type !== "BlockStatement") return;

    const fnSource = source.slice(node.start, node.end);
    if (!fnSource.includes(IDENTITY_ERROR)) return;
    if (!fnSource.includes(REQUEST_HEADER_GATE)) return;

    const gateReturn = node.body.body.find(
      (statement) =>
        statement.type === "ReturnStatement" &&
        statement.argument &&
        source
          .slice(statement.argument.start, statement.argument.end)
          .includes(REQUEST_HEADER_GATE),
    );
    if (!gateReturn) return;

    const gateExpression = source.slice(
      gateReturn.argument.start,
      gateReturn.argument.end,
    );
    patches.push({
      id: "browser_request_header_auth_fallback",
      start: node.body.start,
      end: node.body.end,
      replacement: `{try{return ${gateExpression}}catch{return!1}}`,
      original: fnSource,
    });
  });

  return patches;
}

function findInlineRequestHeaderAuthPatches(ast, source) {
  const gateReaders = new Set();
  walk(ast, (node) => {
    if (node.type !== "FunctionDeclaration" || !node.async || !node.id) return;
    if (source.slice(node.start, node.end).includes(FEATURE_GATE_IDENTITY_ERROR)) {
      gateReaders.add(node.id.name);
    }
  });

  const patches = [];
  walk(ast, (node) => {
    if (node.type !== "ArrowFunctionExpression" || node.params.length !== 0) return;
    const call = node.body;
    if (call.type !== "CallExpression" || call.callee.type !== "Identifier") return;
    if (!gateReaders.has(call.callee.name)) return;
    if (call.arguments[0]?.type !== "Literal") return;
    if (call.arguments[0].value !== REQUEST_HEADER_GATE) return;

    const expression = source.slice(call.start, call.end);
    const arrow = source.slice(node.start, call.start);
    patches.push({
      id: "browser_request_header_auth_fallback",
      start: node.start,
      end: node.end,
      replacement: `${node.async ? "" : "async "}${arrow}{try{return await ${expression}}catch{return!1}}`,
      original: source.slice(node.start, node.end),
    });
  });
  return patches;
}

function hasPatchedFallback(ast, source) {
  let found = false;
  walk(ast, (node) => {
    if (found || !isFunction(node) || !node.async) return;
    const fnSource = source.slice(node.start, node.end);
    if (!fnSource.includes(REQUEST_HEADER_GATE)) return;
    if (hasFallbackCatch(node)) found = true;
  });
  return found;
}

function applyPatches(source, patches) {
  let next = source;
  for (const patch of [...patches].sort((left, right) => right.start - left.start)) {
    next =
      next.slice(0, patch.start) +
      patch.replacement +
      next.slice(patch.end);
  }
  return next;
}

function patchSource(source) {
  if (!source.includes(REQUEST_HEADER_GATE)) {
    return { status: "not-applicable", source, count: 0 };
  }

  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const patches = [
    ...findRequestHeaderAuthPatches(ast, source),
    ...findInlineRequestHeaderAuthPatches(ast, source),
  ];
  if (patches.length === 0) {
    return {
      status: hasPatchedFallback(ast, source)
        ? "already-patched"
        : "unexpected-shape",
      source,
      count: 0,
    };
  }
  if (patches.length !== 1) {
    return { status: "unexpected-count", source, count: patches.length };
  }

  const next = applyPatches(source, patches);
  parse(next, { ecmaVersion: "latest", sourceType: "module" });
  return { status: "patched", source: next, count: patches.length };
}

function findBrowserServices(root) {
  if (!fs.existsSync(root)) return [];
  const results = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile() && entry.name === "browser-service.mjs") {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function locateTargets(platform) {
  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((name) =>
        fs.existsSync(path.join(SRC_DIR, name)),
      );
  const targets = [];

  for (const name of platforms) {
    const roots = [
      path.join(SRC_DIR, name, "plugins"),
      path.join(SRC_DIR, name, "cua_node"),
    ];
    for (const root of roots) {
      for (const filePath of findBrowserServices(root)) {
        const source = fs.readFileSync(filePath, "utf8");
        if (source.includes(REQUEST_HEADER_GATE)) {
          targets.push({ platform: name, path: filePath });
        }
      }
    }
  }

  return targets.sort((left, right) => left.path.localeCompare(right.path));
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const platform = args.find((arg) =>
    ["mac-arm64", "mac-x64", "win"].includes(arg),
  );
  const targets = locateTargets(platform);

  if (targets.length === 0) {
    console.log("[ok] No browser request-header auth targets found");
    return;
  }

  let patched = 0;
  let alreadyPatched = 0;
  for (const target of targets) {
    const source = fs.readFileSync(target.path, "utf8");
    const result = patchSource(source);
    const label = `[${target.platform}] ${relPath(target.path)}`;

    if (result.status === "patched") {
      if (check) {
        console.log(`[?] ${label}: API-key auth fallback patch required`);
      } else {
        fs.writeFileSync(target.path, result.source, "utf8");
        console.log(`[*] ${label}: API-key auth fallback patched`);
      }
      patched++;
      continue;
    }
    if (result.status === "already-patched") {
      console.log(`[ok] ${label}: already patched`);
      alreadyPatched++;
      continue;
    }

    throw new Error(`${label}: unsupported browser auth shape (${result.status})`);
  }

  console.log(
    `[ok] Browser auth targets: ${targets.length}, patched: ${patched}, already: ${alreadyPatched}`,
  );
}

if (require.main === module) main();

module.exports = {
  IDENTITY_ERROR,
  REQUEST_HEADER_GATE,
  findRequestHeaderAuthPatches,
  locateTargets,
  patchSource,
};
