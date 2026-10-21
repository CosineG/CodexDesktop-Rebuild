#!/usr/bin/env node
/**
 * 将对话右键菜单的系统文件管理器入口提升到顶层。
 *
 * 26.825 起，上游把工作区的所有打开目标统一收进“打开方式”子菜单；
 * 26.901 又把侧边栏会话菜单拆到 app-primary，并仅为 Git 会话调用该菜单；
 * 26.908 将该限制移入派生选择器；26.911 又将菜单构造器移回 app-initial；
 * 26.1016 的远程连接状态改为读取独立 selector，不再内联配置项名称。
 * 顶层入口复用工作区菜单的打开回调，保留工作树解析和失败提示；不能调用
 * 需要 ThreadScope 的文件预览函数，否则全局侧边栏会抛 Missing scope instance。
 * 本补丁先复用打开链路增加顶层入口，再按内容定位侧边栏菜单并放宽两种
 * 结构中的 Git 限制，使所有有工作目录的本地会话都能显示入口。旧版若已
 * 提供 open-thread-folder，则安全跳过。
 *
 * Usage:
 *   node scripts/patch-thread-file-manager-action.js [platform]
 *   node scripts/patch-thread-file-manager-action.js --check
 */
const fs = require("fs");
const acorn = require("acorn");
const { locateBundles, relPath } = require("./patch-util");

const PLATFORMS = ["mac-arm64", "mac-x64", "win"];
const LEGACY_MARKER = "/* Codex：对话菜单直接显示系统文件管理器入口。 */";
const MARKER = "/* Codex：对话菜单通过工作区打开链路显示系统文件管理器入口（v2）。 */";
const SIDEBAR_MARKER =
  "/* Codex：侧边栏会话菜单对普通目录显示打开入口。 */";
const DIRECT_ACTION_ID = "open-workspace-file-manager-direct";
const PATCHABLE_SIGNATURES = [
  "localConversation.openTarget.error",
  "localConversationPage.openPrimaryTarget",
  "persistPreferredTargetPath",
];
const SIDEBAR_PATCHABLE_SIGNATURES = [
  "id:`rename-thread`",
  "id:`archive-thread`",
  "id:`open-in-new-window`",
];
const SIDEBAR_BUNDLE_SIGNATURES = [
  "rename-thread",
  "archive-thread",
  "open-in-new-window",
  "remote_control_connections",
];

function hasSidebarMenuSignatures(source) {
  return SIDEBAR_BUNDLE_SIGNATURES.every((signature) =>
    source.includes(signature),
  );
}

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visitor);
    } else if (value && typeof value === "object" && value.type) {
      walk(value, visitor);
    }
  }
}

function walkWithAncestors(node, visitor, ancestors = []) {
  if (!node || typeof node !== "object") return;
  if (node.type) {
    visitor(node, ancestors);
    ancestors.push(node);
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    if (Array.isArray(value)) {
      for (const child of value) walkWithAncestors(child, visitor, ancestors);
    } else if (value && typeof value === "object" && value.type) {
      walkWithAncestors(value, visitor, ancestors);
    }
  }
  if (node.type) ancestors.pop();
}

function propertyName(property) {
  if (property?.key?.type === "Identifier") return property.key.name;
  if (property?.key?.type === "Literal") return property.key.value;
  return null;
}

function objectPatternBindings(pattern) {
  const bindings = new Map();
  if (pattern?.type !== "ObjectPattern") return bindings;

  for (const property of pattern.properties) {
    if (property.type !== "Property") continue;
    const key = propertyName(property);
    const value =
      property.value?.type === "Identifier"
        ? property.value
        : property.value?.type === "AssignmentPattern" &&
            property.value.left?.type === "Identifier"
          ? property.value.left
          : null;
    if (key != null && value != null) bindings.set(key, value.name);
  }
  return bindings;
}

function functionBindings(node) {
  const direct = objectPatternBindings(node.params[0]);
  if (direct.size > 0 || node.params[0]?.type !== "Identifier") return direct;

  const parameter = node.params[0].name;
  for (const statement of node.body.body) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declaration of statement.declarations) {
      if (
        declaration.id?.type === "ObjectPattern" &&
        declaration.init?.type === "Identifier" &&
        declaration.init.name === parameter
      ) {
        return objectPatternBindings(declaration.id);
      }
    }
  }
  return direct;
}

function bodyObjectBindings(node, sourceBinding) {
  if (sourceBinding == null) return new Map();
  for (const statement of node.body.body) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declaration of statement.declarations) {
      if (
        declaration.id?.type === "ObjectPattern" &&
        declaration.init?.type === "Identifier" &&
        declaration.init.name === sourceBinding
      ) {
        return objectPatternBindings(declaration.id);
      }
    }
  }
  return new Map();
}

function objectExpressionProperties(node) {
  const properties = new Map();
  if (node?.type !== "ObjectExpression") return properties;
  for (const property of node.properties) {
    if (property.type !== "Property") continue;
    const key = propertyName(property);
    if (key != null) properties.set(key, property.value);
  }
  return properties;
}

function memberName(node) {
  if (node?.type !== "MemberExpression") return null;
  if (!node.computed && node.property?.type === "Identifier") {
    return node.property.name;
  }
  if (node.computed && node.property?.type === "Literal") {
    return node.property.value;
  }
  return null;
}

function hasNativeDirectAction(source) {
  return /id:\s*[`'"](?:open-thread-folder|reveal-thread-folder)[`'"]/.test(
    source,
  );
}

function parse(source) {
  return acorn.parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
  });
}

function findPatchContext(ast, source) {
  const menuBuilders = [];

  walk(ast, (node) => {
    if (node.type !== "FunctionDeclaration" || node.id?.type !== "Identifier") {
      return;
    }

    const bindings = functionBindings(node);
    const mayBuildMenu = ["scope", "cwd", "hostId"].every((key) =>
      bindings.has(key),
    );
    if (!mayBuildMenu) return;
    const code = source.slice(node.start, node.end);

    if (
      mayBuildMenu &&
      code.includes("localConversation.openTarget.error") &&
      code.includes("persistPreferredTargetPath") &&
      code.includes("openMode:`workspace`") &&
      code.includes(".query.fetch(")
    ) {
      const scope = bindings.get("scope");
      const returns = node.body.body.filter(
        (statement) =>
          statement.type === "ReturnStatement" &&
          statement.argument?.type === "CallExpression",
      );
      const targetsVariables = [];
      for (const statement of node.body.body) {
        if (statement.type !== "VariableDeclaration") continue;
        for (const declaration of statement.declarations) {
          const callee = declaration.init?.callee;
          if (
            declaration.id?.type === "Identifier" &&
            declaration.init?.type === "CallExpression" &&
            callee?.type === "MemberExpression" &&
            callee.computed === false &&
            callee.property?.name === "getData" &&
            callee.object?.type === "MemberExpression" &&
            callee.object.computed === false &&
            callee.object.object?.type === "Identifier" &&
            callee.object.object.name === scope &&
            callee.object.property?.name === "query"
          ) {
            targetsVariables.push(declaration.id.name);
          }
        }
      }
      menuBuilders.push({ bindings, returns, targetsVariables });
    }

  });

  return { menuBuilders };
}

function workspaceOpenCallback(call, source, scope) {
  const callback = objectExpressionProperties(call.arguments[0]).get("onOpenInTarget");
  if (!callback || !["ArrowFunctionExpression", "FunctionExpression"].includes(callback.type)) {
    return null;
  }
  const edits = [];
  let hasOpenMutation = false;
  walk(callback, (node) => {
    if (node.type === "Property" && propertyName(node) === "persistPreferredTargetPath") {
      // 单次打开资源管理器不能覆盖用户偏好的编辑器或终端。
      edits.push({ start: node.value.start, end: node.value.end, text: "void 0" });
    }
    if (node.type !== "CallExpression") return;
    const properties = objectExpressionProperties(node.arguments[0]);
    if (["mutate", "mutateAsync"].includes(memberName(node.callee)) &&
        ["path", "cwd", "hostId", "target", "openMode"].every((key) => properties.has(key))) {
      hasOpenMutation = true;
    }
    const owner = node.callee?.object;
    if (memberName(node.callee) === "setData" && memberName(owner) === "query" &&
        owner.object?.name === scope && source.slice(node.start, node.end).includes("preferredTarget")) {
      edits.push({ start: node.start, end: node.end, text: "void 0" });
    }
  });
  if (!hasOpenMutation) return null;
  let code = source.slice(callback.start, callback.end);
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    code = code.slice(0, edit.start - callback.start) + edit.text + code.slice(edit.end - callback.start);
  }
  return code;
}

function restoreLegacyMenu(ast, source) {
  const contexts = [];
  walk(ast, (node) => {
    if (node.type !== "FunctionDeclaration") return;
    let declaration;
    for (const statement of node.body.body) {
      if (statement.type !== "VariableDeclaration") continue;
      const value = statement.declarations.find((item) =>
        item.id?.name === "__codexOpenWorkspaceItems" && item.init?.type === "CallExpression");
      if (value) declaration = { statement, value };
    }
    const returns = node.body.body.filter((statement) => statement.type === "ReturnStatement" &&
      statement.argument?.type === "ArrayExpression" &&
      source.slice(statement.start, statement.end).includes(LEGACY_MARKER));
    if (declaration && returns.length === 1) contexts.push({ ...declaration, returnNode: returns[0] });
  });
  if (contexts.length !== 1) return null;
  const { statement, value, returnNode } = contexts[0];
  return source.slice(0, statement.start) + `return ${source.slice(value.init.start, value.init.end)};` +
    source.slice(returnNode.end);
}

function findSidebarPatchContexts(ast, source) {
  const selectorGitGates = new Map();
  const contexts = [];

  // 26.908 起，Git 仓库限制位于派生选择器中，而不是菜单 push 表达式中。
  walkWithAncestors(ast, (node, ancestors) => {
    if (node.type !== "ArrowFunctionExpression") return;

    const call = ancestors.at(-1);
    const owner = ancestors.at(-2);
    if (call?.type !== "CallExpression" || !call.arguments.includes(node)) return;

    const selectorName =
      owner?.type === "AssignmentExpression" &&
      owner.right === call &&
      owner.left?.type === "Identifier"
        ? owner.left.name
        : owner?.type === "VariableDeclarator" &&
            owner.init === call &&
            owner.id?.type === "Identifier"
          ? owner.id.name
          : null;
    if (selectorName == null) return;

    const targetBindings = objectPatternBindings(node.params[0]);
    const stateBindings = objectPatternBindings(node.params[1]);
    const conversationId = targetBindings.get("conversationId");
    const hostId = targetBindings.get("hostId");
    const get = stateBindings.get("get");
    const code = source.slice(node.start, node.end);
    if (
      conversationId == null ||
      hostId == null ||
      get == null ||
      !(code.includes("remote_control_connections") ||
        (code.includes(".some(") && code.includes(`.hostId===${hostId}`)))
    ) {
      return;
    }

    const gitGates = [];
    walk(node.body, (candidate) => {
      if (
        candidate.type === "CallExpression" &&
        candidate.callee?.type === "Identifier" &&
        candidate.callee.name === get &&
        candidate.arguments[0]?.type === "Identifier" &&
        candidate.arguments.some(
          (argument) =>
            argument.type === "Identifier" &&
            argument.name === conversationId,
        )
      ) {
        gitGates.push(candidate);
      }
    });

    if (gitGates.length === 1) {
      selectorGitGates.set(selectorName, gitGates[0]);
    }
  });

  walk(ast, (functionNode) => {
    if (
      functionNode.type !== "FunctionDeclaration" ||
      functionNode.id?.type !== "Identifier"
    ) {
      return;
    }

    const code = source.slice(functionNode.start, functionNode.end);
    if (
      !SIDEBAR_PATCHABLE_SIGNATURES.every((signature) =>
        code.includes(signature),
      )
    ) {
      return;
    }

    const bindings = functionBindings(functionNode);
    const scope = bindings.get("scope");
    const target = bindings.get("target");
    const targetBindings = bodyObjectBindings(functionNode, target);
    const conversationId = targetBindings.get("conversationId");
    const hostId = targetBindings.get("hostId");
    if (scope == null || conversationId == null || hostId == null) return;

    walkWithAncestors(functionNode.body, (node, ancestors) => {
      if (node.type !== "CallExpression") return;
      const properties = objectExpressionProperties(node.arguments[0]);
      if (
        properties.get("scope")?.type !== "Identifier" ||
        properties.get("scope").name !== scope ||
        !properties.has("cwd") ||
        properties.get("hostId")?.type !== "Identifier" ||
        properties.get("hostId").name !== hostId
      ) {
        return;
      }

      const spread = ancestors.at(-1);
      const pushCall = ancestors.at(-2);
      const logical = ancestors.at(-3);
      if (
        spread?.type !== "SpreadElement" ||
        spread.argument !== node ||
        pushCall?.type !== "CallExpression" ||
        memberName(pushCall.callee) !== "push" ||
        logical?.type !== "LogicalExpression" ||
        logical.operator !== "&&" ||
        logical.right !== pushCall ||
        logical.left?.type !== "LogicalExpression" ||
        logical.left.operator !== "&&"
      ) {
        return;
      }

      const gitGate = logical.left.right;
      const isScopeGetCall =
        gitGate?.type === "CallExpression" &&
        gitGate.callee?.type === "MemberExpression" &&
        memberName(gitGate.callee) === "get" &&
        gitGate.callee.object?.type === "Identifier" &&
        gitGate.callee.object.name === scope;
      const isInlineGitGate =
        isScopeGetCall &&
        gitGate.arguments.some(
          (argument) =>
            argument.type === "Identifier" && argument.name === conversationId,
        );

      if (isInlineGitGate) {
        contexts.push({
          kind: "inline",
          logical,
          preservedCondition: logical.left.left,
          pushCall,
        });
        return;
      }

      if (
        gitGate?.type !== "CallExpression" ||
        gitGate.callee?.type !== "MemberExpression" ||
        memberName(gitGate.callee) !== "get" ||
        gitGate.callee.object?.type !== "Identifier" ||
        gitGate.callee.object.name !== scope ||
        gitGate.arguments[0]?.type !== "Identifier"
      ) {
        return;
      }

      const selectorGitGate = selectorGitGates.get(gitGate.arguments[0].name);
      const selectorTarget = objectExpressionProperties(gitGate.arguments[1]);
      if (
        selectorGitGate == null ||
        selectorTarget.get("conversationId")?.type !== "Identifier" ||
        selectorTarget.get("conversationId").name !== conversationId ||
        selectorTarget.get("hostId")?.type !== "Identifier" ||
        selectorTarget.get("hostId").name !== hostId
      ) {
        return;
      }

      contexts.push({
        kind: "selector",
        selectorGitGate,
      });
    });
  });

  return contexts;
}

function fileManagerMessageExpression(platformVariable) {
  const finder =
    "{id:`sidebarElectron.openWorkspaceRootInFinder`," +
    "defaultMessage:`Reveal in Finder`," +
    "description:`Menu item to reveal a folder in Finder`}";
  const explorer =
    "{id:`sidebarElectron.openWorkspaceRootInExplorer`," +
    "defaultMessage:`Open in Explorer`," +
    "description:`Menu item to open a folder in File Explorer`}";
  const fileManager =
    "{id:`sidebarElectron.openWorkspaceRootInFileManager`," +
    "defaultMessage:`Open in File Manager`," +
    "description:`Menu item to open a folder in the system file manager`}";

  return (
    `${platformVariable}.startsWith(\`mac\`)?${finder}:` +
    `${platformVariable}.startsWith(\`win\`)?${explorer}:${fileManager}`
  );
}

function patchSource(source) {
  if (source.includes(MARKER)) {
    return { status: "already-patched", source };
  }
  const hasNativeAction = hasNativeDirectAction(source);
  const hasPatchableSignatures = PATCHABLE_SIGNATURES.every((signature) =>
    source.includes(signature),
  );
  if (hasNativeAction && !hasPatchableSignatures) {
    return { status: "native", source };
  }

  let ast;
  try {
    ast = parse(source);
  } catch (error) {
    return { status: "parse-failed", phase: "before", error, source };
  }

  if (source.includes(LEGACY_MARKER)) {
    const restored = restoreLegacyMenu(ast, source);
    if (restored == null) return { status: "unexpected-legacy-menu", source };
    const result = patchSource(restored);
    return result.status === "patched" ? result : { ...result, source };
  }

  const { menuBuilders } = findPatchContext(ast, source);
  if (menuBuilders.length === 0 && hasNativeAction) {
    return { status: "native", source };
  }
  if (menuBuilders.length !== 1) {
    return {
      status: "unexpected-menu-builder-count",
      count: menuBuilders.length,
      source,
    };
  }
  const [{ bindings, returns, targetsVariables }] = menuBuilders;
  if (returns.length !== 1) {
    return {
      status: "unexpected-return-count",
      count: returns.length,
      source,
    };
  }

  const [returnNode] = returns;
  const scope = bindings.get("scope");
  const callback = workspaceOpenCallback(returnNode.argument, source, scope);
  if (callback == null) return { status: "missing-workspace-open-callback", source };
  const originalItems = source.slice(
    returnNode.argument.start,
    returnNode.argument.end,
  );
  const itemsVariable = "__codexOpenWorkspaceItems";
  const targetVariable = "__codexFileManagerTarget";
  const platformVariable = "__codexDesktopPlatform";
  const callbackVariable = "__codexOpenWorkspaceInTarget";
  const replacement = [
    `let ${itemsVariable}=${originalItems};`,
    `let ${callbackVariable}=${callback};`,
    ...(targetsVariables.length === 1
      ? [
          `let ${targetVariable}=${targetsVariables[0]}?.targets.find(` +
            `e=>e.target===\`fileManager\`);`,
        ]
      : []),
    `let ${platformVariable}=(` +
      `globalThis.navigator?.userAgentData?.platform??` +
      `globalThis.navigator?.platform??\`\`).toLowerCase();`,
    "return[",
    `{${MARKER}`,
    `id:\`${DIRECT_ACTION_ID}\`,`,
    `message:${fileManagerMessageExpression(platformVariable)},`,
    `icon:${
      targetsVariables.length === 1
        ? `${targetVariable}?.resolvedIcon??${targetVariable}?.icon??`
        : ""
    }${itemsVariable}[0]?.icon,`,
    `onSelect:()=>${callbackVariable}(\`fileManager\`)},`,
    `...${itemsVariable}]`,
  ].join("");
  const next =
    source.slice(0, returnNode.start) +
    replacement +
    source.slice(returnNode.end);

  try {
    parse(next);
  } catch (error) {
    return { status: "parse-failed", phase: "after", error, source };
  }

  return { status: "patched", source: next };
}

function patchSidebarSource(source) {
  if (source.includes(SIDEBAR_MARKER)) {
    return { status: "already-patched", source };
  }
  if (hasNativeDirectAction(source)) {
    return { status: "native", source };
  }

  let ast;
  try {
    ast = parse(source);
  } catch (error) {
    return { status: "parse-failed", phase: "before", error, source };
  }

  const contexts = findSidebarPatchContexts(ast, source);
  if (contexts.length !== 1) {
    return {
      status: "unexpected-sidebar-menu-gate-count",
      count: contexts.length,
      source,
    };
  }

  const [context] = contexts;
  let next;
  if (context.kind === "selector") {
    const { selectorGitGate } = context;
    next =
      source.slice(0, selectorGitGate.start) +
      `!0${SIDEBAR_MARKER}` +
      source.slice(selectorGitGate.end);
  } else {
    const { logical, preservedCondition, pushCall } = context;
    const replacement =
      source.slice(preservedCondition.start, preservedCondition.end) +
      `&&${SIDEBAR_MARKER}` +
      source.slice(pushCall.start, pushCall.end);
    next =
      source.slice(0, logical.start) + replacement + source.slice(logical.end);
  }

  try {
    parse(next);
  } catch (error) {
    return { status: "parse-failed", phase: "after", error, source };
  }

  return { status: "patched", source: next };
}

function findTargets(platform) {
  const appInitialTargets = locateBundles({
    dir: "assets",
    pattern: /^app-initial-.*\.js$/,
    ...(platform ? { platform } : {}),
  })
    .map((target) => ({
      ...target,
      source: fs.readFileSync(target.path, "utf-8"),
    }));
  const appPrimaryTargets = locateBundles({
    dir: "assets",
    pattern: /^app-primary-.*\.js$/,
    ...(platform ? { platform } : {}),
  })
    .map((target) => ({
      ...target,
      source: fs.readFileSync(target.path, "utf-8"),
    }));

  const openMenuTargets = appInitialTargets.map((target) => ({
    ...target,
    patchKind: "open-menu",
  }));
  const sidebarTargets = [...appInitialTargets, ...appPrimaryTargets]
    .filter(
      ({ source }) =>
        source.includes(SIDEBAR_MARKER) || hasSidebarMenuSignatures(source),
    )
    .map((target) => ({ ...target, patchKind: "sidebar" }));

  return [...openMenuTargets, ...sidebarTargets];
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((item) => PLATFORMS.includes(item));
  const targets = findTargets(platform);

  if (targets.length === 0) {
    console.log("  [skip] No matching thread action bundle found");
    return;
  }

  let patched = 0;
  let failed = 0;
  for (const target of targets) {
    const label = relPath(target.path);
    // 新版的两个补丁可能落在同一 bundle，必须读取上一阶段写入后的内容。
    const source = fs.readFileSync(target.path, "utf-8");
    const result =
      target.patchKind === "sidebar"
        ? patchSidebarSource(source)
        : patchSource(source);

    if (result.status === "native") {
      console.log(
        `  [ok] ${label}: upstream exposes the thread folder action directly`,
      );
      continue;
    }
    if (result.status === "already-patched") {
      console.log(`  [ok] ${label}: already patched`);
      continue;
    }
    if (result.status === "patched") {
      if (isCheck) {
        console.log(
          `  [?] ${label}: would expose the file manager action (${target.patchKind})`,
        );
      } else {
        fs.writeFileSync(target.path, result.source, "utf-8");
        console.log(
          `  [ok] ${label}: file manager action exposed (${target.patchKind})`,
        );
      }
      patched++;
      continue;
    }

    const detail =
      result.count == null
        ? result.error?.message ?? result.status
        : `${result.status} (${result.count})`;
    console.log(`  [x] ${label}: ${detail}`);
    failed++;
  }

  console.log(
    `  [done] ${isCheck ? "would patch" : "patched"} ${patched} file(s)`,
  );
  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  DIRECT_ACTION_ID,
  LEGACY_MARKER,
  MARKER,
  SIDEBAR_MARKER,
  findTargets,
  hasSidebarMenuSignatures,
  hasNativeDirectAction,
  patchSidebarSource,
  patchSource,
};
