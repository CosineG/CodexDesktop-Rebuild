#!/usr/bin/env node
/**
 * 为自定义 Responses provider 的 API-key 登录补齐受限能力。
 *
 * 上游 CLI 会把 image_gen 限制为 ChatGPT backend 或 actor-authorization
 * provider，并要求 API-key 模型发现显式配置目录地址与实验特性。桌面端启动
 * app-server 时，本补丁按用户配置识别自定义 base_url，将 API key 通过子进程
 * 环境传入 provider，并补齐 CLI 所需的能力标记。
 * 用户 config.toml 与 auth.json 均不会被修改，API key 也不会进入命令行。
 */
const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("acorn");
const { SRC_DIR, relPath } = require("./patch-util");

const RUNTIME_FILENAME = "codex-image-generation-auth.cjs";
const TOML_FILENAME = "codex-image-generation-toml.cjs";
const RUNTIME_REQUIRE = `./${RUNTIME_FILENAME}`;
const FEATURE_CONFIG = "features.code_mode_host=true";
const OPENAI_BASE_URL_ENV = "CODEX_APP_SERVER_OPENAI_BASE_URL";
const APP_SERVER_FLAG = "--analytics-default-enabled";

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node);
  for (const [key, child] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    if (Array.isArray(child)) {
      for (const item of child) walk(item, visitor);
    } else {
      walk(child, visitor);
    }
  }
}

function staticString(node) {
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (
    node?.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    return node.quasis[0].value.cooked;
  }
  return null;
}

function findBaseArgsNames(ast) {
  const names = [];
  walk(ast, (node) => {
    if (
      node.type !== "VariableDeclarator" ||
      node.id?.type !== "Identifier" ||
      node.init?.type !== "ArrayExpression"
    ) {
      return;
    }
    const values = node.init.elements.map(staticString);
    if (values.includes("-c") && values.includes(FEATURE_CONFIG)) {
      names.push(node.id.name);
    }
  });
  return names;
}

function findFactoryPatch(ast, source, baseArgsName) {
  const candidates = [];
  walk(ast, (node) => {
    if (node.type !== "FunctionDeclaration" || node.body == null) return;
    const bodySource = source.slice(node.body.start, node.body.end);
    if (!bodySource.includes("app-server") || !bodySource.includes(APP_SERVER_FLAG)) {
      return;
    }

    const spreads = [];
    walk(node.body, (child) => {
      if (
        child.type === "SpreadElement" &&
        child.argument?.type === "Identifier" &&
        child.argument.name === baseArgsName
      ) {
        spreads.push(child.argument);
      }
    });
    if (spreads.length > 0) candidates.push({ node, spreads });
  });

  if (candidates.length !== 1) {
    return {
      status: "unexpected-factory-count",
      count: candidates.length,
    };
  }
  if (candidates[0].spreads.length !== 2) {
    return { status: "unexpected-spread-count", count: candidates[0].spreads.length };
  }
  return { status: "found", ...candidates[0] };
}

function patchSource(source) {
  if (source.includes(RUNTIME_REQUIRE)) {
    return { status: "already-patched", source, count: 0 };
  }
  if (
    !source.includes(FEATURE_CONFIG) ||
    !source.includes(OPENAI_BASE_URL_ENV) ||
    !source.includes(APP_SERVER_FLAG)
  ) {
    return { status: "not-applicable", source, count: 0 };
  }

  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const baseArgsNames = findBaseArgsNames(ast);
  if (baseArgsNames.length !== 1) {
    return {
      status: "unexpected-base-args-count",
      source,
      count: baseArgsNames.length,
    };
  }

  const match = findFactoryPatch(ast, source, baseArgsNames[0]);
  if (match.status !== "found") {
    return { ...match, source };
  }

  let next = source;
  const replacement = `require(${JSON.stringify(RUNTIME_REQUIRE)}).withImageGenerationAuth(${baseArgsNames[0]})`;
  for (const identifier of [...match.spreads].sort(
    (left, right) => right.start - left.start,
  )) {
    next =
      next.slice(0, identifier.start) +
      replacement +
      next.slice(identifier.end);
  }
  parse(next, { ecmaVersion: "latest", sourceType: "module" });
  return { status: "patched", source: next, count: match.spreads.length };
}

function platformNames(platform, srcDir = SRC_DIR) {
  return platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((name) =>
        fs.existsSync(path.join(srcDir, name, "_asar", ".vite", "build")),
      );
}

/**
 * 定位 app-server 参数 bundle；上游可能把同一模块拆进多个 chunk，全部都要补。
 * 单个平台存在 build 目录但零命中时明确报错，避免静默漏补。
 */
function locateTargets(platform, srcDir = SRC_DIR) {
  const targets = [];
  for (const name of platformNames(platform, srcDir)) {
    const buildDir = path.join(srcDir, name, "_asar", ".vite", "build");
    if (!fs.existsSync(buildDir)) continue;
    const matches = fs
      .readdirSync(buildDir)
      .filter((file) => file.endsWith(".js"))
      .sort()
      .map((file) => path.join(buildDir, file))
      .filter((file) => {
        const source = fs.readFileSync(file, "utf8");
        return (
          source.includes(FEATURE_CONFIG) &&
          source.includes(OPENAI_BASE_URL_ENV) &&
          source.includes(APP_SERVER_FLAG)
        );
      });
    if (matches.length === 0) {
      throw new Error(`[${name}] no app-server argument bundle found`);
    }
    for (const filePath of matches) {
      targets.push({ platform: name, path: filePath, buildDir });
    }
  }
  return targets;
}

function filesEqual(left, right) {
  return fs.existsSync(right) && fs.readFileSync(left).equals(fs.readFileSync(right));
}

function runtimeFiles(buildDir) {
  return [
    {
      source: path.join(__dirname, "runtime", "image-generation-auth.cjs"),
      destination: path.join(buildDir, RUNTIME_FILENAME),
    },
    {
      source: require.resolve("smol-toml"),
      destination: path.join(buildDir, TOML_FILENAME),
    },
  ];
}

function syncRuntimeFiles(buildDir, check) {
  let changed = 0;
  for (const file of runtimeFiles(buildDir)) {
    if (filesEqual(file.source, file.destination)) continue;
    changed++;
    if (!check) fs.copyFileSync(file.source, file.destination);
  }
  return changed;
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const platform = args.find((arg) =>
    ["mac-arm64", "mac-x64", "win"].includes(arg),
  );
  const targets = locateTargets(platform);
  if (targets.length === 0) {
    console.log("[ok] No generated app-server bundles found");
    return;
  }

  let changed = 0;
  // 多个重复 bundle 共享同一 buildDir，runtime 文件只同步一次，避免重复计数。
  const syncedBuildDirs = new Set();
  for (const target of targets) {
    const source = fs.readFileSync(target.path, "utf8");
    const result = patchSource(source);
    const label = `[${target.platform}] ${relPath(target.path)}`;

    if (result.status === "patched") {
      changed++;
      if (check) {
        console.log(`[?] ${label}: image-generation auth patch required`);
      } else {
        fs.writeFileSync(target.path, result.source, "utf8");
        console.log(`[*] ${label}: image-generation auth patched`);
      }
    } else if (result.status === "already-patched") {
      console.log(`[ok] ${label}: already patched`);
    } else {
      throw new Error(
        `${label}: unsupported app-server argument shape (${result.status})`,
      );
    }

    if (syncedBuildDirs.has(target.buildDir)) continue;
    syncedBuildDirs.add(target.buildDir);
    const runtimeChanged = syncRuntimeFiles(target.buildDir, check);
    if (runtimeChanged > 0) {
      changed += runtimeChanged;
      console.log(
        check
          ? `[?] ${label}: ${runtimeChanged} runtime file(s) need syncing`
          : `[*] ${label}: ${runtimeChanged} runtime file(s) synced`,
      );
    }
  }

  console.log(
    check
      ? `[check] ${changed} image-generation patch item(s) need changes`
      : `[done] ${changed} image-generation patch item(s) changed`,
  );
}

if (require.main === module) main();

module.exports = {
  APP_SERVER_FLAG,
  FEATURE_CONFIG,
  OPENAI_BASE_URL_ENV,
  RUNTIME_FILENAME,
  RUNTIME_REQUIRE,
  findBaseArgsNames,
  locateTargets,
  patchSource,
  runtimeFiles,
  syncRuntimeFiles,
};
