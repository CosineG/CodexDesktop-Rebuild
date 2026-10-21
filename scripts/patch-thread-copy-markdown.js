#!/usr/bin/env node
/**
 * 修复侧边栏尚未打开的会话“复制为 Markdown”无响应。
 *
 * 26.1016 的 ensureConversationHistoryLoaded 在尾部加载未启用时默认不做
 * 任何操作，且未挂载会话页面时前端没有历史订阅。复制显式请求完整历史，
 * 前端没有内容时从后台完整快照调用原生渲染器，包含子代理的父会话；空内容
 * 或剪贴板失败进入原生错误提示。只修改复制动作，不改变全局历史加载策略。
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { SRC_DIR, relPath } = require("./patch-util");

const MARKER = "/* Codex：复制 Markdown 前加载完整会话，失败时显示原生提示。 */";
const ERROR_ID = "threadActions.copyConversationMarkdown.copyConversationMarkdownError";

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (node.type) visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (value?.type) walk(value, visit);
  }
}

function name(node) {
  return node?.name ?? node?.value;
}

function operands(node) {
  return node?.type === "LogicalExpression" && node.operator === "&&"
    ? [...operands(node.left), ...operands(node.right)]
    : [node];
}

function nativeHelpers(ast, source) {
  const found = { complete: [], render: [], visible: [], excluded: [] };
  walk(ast, (node) => {
    if (node.type !== "FunctionDeclaration") return;
    const body = source.slice(node.start, node.end);
    const keys = node.params[0]?.type === "ObjectPattern"
      ? node.params[0].properties.map((p) => name(p.key)) : [];
    if (["visibleTurnEntries", "title", "cwd"].every((key) => keys.includes(key)) &&
        body.includes("renderConversationMarkdown")) found.render.push(node.id.name);
    if (["conversationRequests", "conversationTurns", "hasConversation", "parentConversationTurns", "subagentParentThreadId"]
      .every((key) => keys.includes(key))) found.visible.push(node.id.name);
    if (body.includes("Conversation must be resumed before loading history")) {
      walk(node.body, (child) => {
        const call = child.type === "VariableDeclarator" ? child.init : null;
        if (call?.type === "CallExpression" && call.callee.type === "Identifier" &&
            call.arguments.length === 1 && name(call.arguments[0]?.callee?.property) === "getConversation") {
          found.complete.push(call.callee.name);
        }
      });
    }
    const options = node.params[1];
    const optionKeys = options?.type === "ObjectPattern" ? options.properties.map((p) => name(p.key)) : [];
    if (["conversationId", "isBackgroundSubagentsEnabled", "markdownLimit"].every((key) => optionKeys.includes(key)) &&
        body.includes("visibleTurnEntries")) {
      const first = node.body.body[0];
      if (first?.type === "IfStatement" && first.test.type === "CallExpression" &&
          first.test.callee.type === "Identifier" && first.consequent.type === "ReturnStatement" &&
          first.consequent.argument?.type === "Literal" && first.consequent.argument.value === null) {
        found.excluded.push(first.test.callee.name);
      }
    }
  });
  if (Object.values(found).some((matches) => matches.length !== 1)) return null;
  return Object.fromEntries(Object.entries(found).map(([key, matches]) => [key, matches[0]]));
}

function patchSource(source) {
  if (!source.includes(ERROR_ID)) return { status: "not-applicable", source };
  let ast;
  try {
    ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch (error) {
    return { status: "parse-error", source, error };
  }
  if (source.includes(MARKER)) return { status: "already-patched", source };
  const candidates = [];
  walk(ast, (node) => {
    if (node.type !== "FunctionDeclaration" || node.params.length !== 1) return;
    const pattern = node.params[0];
    if (pattern.type !== "ObjectPattern") return;
    const bindings = new Map(pattern.properties.map((p) => [name(p.key), name(p.value)]));
    if (!["scope", "conversationId", "parentConversationId", "getMarkdown", "intl"]
      .every((key) => bindings.has(key))) return;
    if (!source.slice(node.start, node.end).includes(ERROR_ID)) return;
    candidates.push({ node, bindings });
  });
  if (candidates.length !== 1) return { status: "ambiguous", source, count: candidates.length };

  const { node, bindings } = candidates[0];
  const statements = node.body.body;
  const chain = statements[0]?.expression;
  const iife = chain?.callee?.object?.callee;
  const body = iife?.body?.body;
  const ensure = body?.[0]?.expression?.argument;
  const markdown = body?.[1]?.declarations?.[0];
  const condition = body?.[2]?.expression;
  const parts = operands(condition);
  const copy = parts[2];
  const success = parts[3];
  const text = (item) => source.slice(item.start, item.end);
  if (statements.length !== 1 || statements[0].type !== "ExpressionStatement" ||
      name(chain?.callee?.property) !== "catch" || chain.arguments.length !== 1 ||
      iife?.type !== "ArrowFunctionExpression" || !iife.async || body?.length !== 3 ||
      body[0].expression?.type !== "AwaitExpression" ||
      ensure?.type !== "CallExpression" || name(ensure.callee?.property) !== "ensureConversationHistoryLoaded" ||
      ensure.arguments.length !== 2 || name(ensure.arguments[0]) !== bindings.get("conversationId") ||
      body[1].declarations?.length !== 1 || markdown?.id?.type !== "Identifier" ||
      markdown.init?.type !== "AwaitExpression" ||
      markdown.init.argument?.type !== "CallExpression" ||
      name(markdown.init.argument.callee) !== bindings.get("getMarkdown") ||
      body[2].type !== "ExpressionStatement" || parts.length !== 4 ||
      parts[0]?.type !== "BinaryExpression" || parts[1]?.type !== "BinaryExpression" ||
      copy?.type !== "AwaitExpression" || copy.argument?.type !== "CallExpression" ||
      copy.argument.arguments.length !== 1 || name(copy.argument.arguments[0]) !== markdown.id.name ||
      success?.type !== "CallExpression" || name(success.callee?.property) !== "success" ||
      !text(success).includes("copyConversationMarkdownSuccess")) {
    return { status: "unsupported-structure", source };
  }

  const nonempty = `${text(parts[0])}&&${text(parts[1])}`;
  const helpers = nativeHelpers(ast, source);
  if (!helpers) return { status: "unsupported-history-renderer", source };
  const id = bindings.get("conversationId");
  const parent = bindings.get("parentConversationId");
  const value = markdown.id.name;
  // 完整快照由后台提供，不依赖当前页面是否订阅了会话 transcript。
  const fallback = `if(!(${nonempty})){` +
    `const __codexClient=${text(ensure.callee.object)};` +
    `const __codexConversation=await __codexClient.getConversation(${id});` +
    `const __codexParent=${parent}==null?null:await __codexClient.getConversation(${parent});` +
    `if(__codexConversation==null||${helpers.excluded}(__codexConversation.threadSource))throw new Error("会话不可导出");` +
    `const __codexTurns=${helpers.complete}(__codexConversation);` +
    `const __codexParentTurns=${parent}==null?[]:${helpers.complete}(__codexParent);` +
    `if(__codexTurns==null||__codexParentTurns==null)throw new Error("会话历史不完整");` +
    `const {visibleTurnEntries:__codexEntries}=${helpers.visible}({conversationRequests:__codexConversation.requests,conversationTurns:__codexTurns,hasConversation:!0,isBackgroundSubagentsEnabled:!0,parentConversationTurns:__codexParentTurns,subagentParentThreadId:${parent}});` +
    `${value}=await ${helpers.render}({cwd:__codexConversation.cwd,title:__codexConversation.title,projectlessOutputDirectory:__codexConversation.projectlessOutputDirectory,isBackgroundSubagentsEnabled:!0,visibleTurnEntries:__codexEntries});}`;
  const guards = `if(!(${nonempty}))throw new Error("会话没有可复制的内容");` +
    `if(!(${text(copy)}))throw new Error("无法写入剪贴板");${text(success)};`;
  const edits = [
    { start: ensure.end - 1, end: ensure.end - 1, replacement: ",{force:!0}" },
    { start: body[2].start, end: body[2].end, replacement: fallback + guards },
    // 返回原生异步链，保留原有 catch 的错误提示与遥测。
    { start: node.body.start + 1, end: node.body.start + 1, replacement: `${MARKER}return ` },
  ].sort((a, b) => b.start - a.start);
  let result = source;
  for (const edit of edits) result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  parse(result, { ecmaVersion: "latest", sourceType: "module" });
  return { status: "patched", source: result };
}

function findTargets(platform) {
  const platforms = platform ? [platform] : ["mac-arm64", "mac-x64", "win"];
  const targets = [];
  for (const current of platforms) {
    const assets = path.join(SRC_DIR, current, "_asar", "webview", "assets");
    if (!fs.existsSync(assets)) continue;
    for (const file of fs.readdirSync(assets)) {
      if (!file.endsWith(".js")) continue;
      const target = path.join(assets, file);
      const source = fs.readFileSync(target, "utf8");
      if (source.includes(ERROR_ID)) targets.push({ path: target, source });
    }
  }
  return targets;
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const platform = args.find((arg) => ["mac-arm64", "mac-x64", "win"].includes(arg));
  const targets = findTargets(platform);
  if (!targets.length) console.log("[skip] No conversation Markdown copy action found");
  for (const target of targets) {
    const result = patchSource(target.source);
    if (result.status === "already-patched") {
      console.log(`[ok] ${relPath(target.path)}: already patched`);
    } else if (result.status === "patched") {
      if (!check) fs.writeFileSync(target.path, result.source, "utf8");
      console.log(`[${check ? "?" : "ok"}] ${relPath(target.path)}: ${check ? "would patch" : "patched"} conversation Markdown copy`);
    } else {
      console.error(`[x] ${relPath(target.path)}: ${result.status}`);
      process.exitCode = 1;
    }
  }
}

if (require.main === module) main();
module.exports = { MARKER, patchSource, findTargets };
