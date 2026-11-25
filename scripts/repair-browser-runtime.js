#!/usr/bin/env node
/**
 * 将已生成的 Windows Browser Use 运行时同步到指定安装目录和可选插件缓存。
 * 客户端、启动器、服务核心及 WASM 资源按上游实际布局逐项更新；全部预检后备份，失败时回滚本次写入。
 * 不修改 CLI、原生 helper、认证、网站策略或扩展本身。
 *
 * node scripts/repair-browser-runtime.js --resources <安装目录/resources> [--codex-home <目录>] [--check]
 */
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { parse } = require("acorn");
const { SRC_DIR } = require("./patch-util");
const { planRouting, patchSource } = require("./patch-windows-browser-routing");

const RUNTIME_DIRS = [
  "cua_node/bin/node_modules/@oai/browser-desktop/scripts",
  "cua_node/bin/node_modules/@oai/cua/dist/lib/js/oai_js_browser/dist/skill/scripts",
  "plugins/openai-bundled/plugins/browser/scripts",
  "plugins/openai-bundled/plugins/chrome/scripts",
];
const RUNTIME_FILES = [
  "browser-client.mjs", "browser-client.js",
  "browser-service.mjs", "browser-service-core.mjs",
  "browser-accessibility.wasm.br", "zxing_reader.wasm",
];
// 上游把服务拆成启动器和核心；启动器可能是无协议的瘦壳，需要继续查找核心。
const SERVICE_FILES = ["browser-service.mjs", "browser-service-core.mjs"];

function walk(node, visit) {
  if (!node?.type) return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (value?.type) walk(value, visit);
  }
}

function assertNetworkPolicySupport(source, label) {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  let readsPolicy = false;
  let forwardsPolicy = false;
  let attachesPolicy = false;
  walk(ast, (node) => {
    if (node.type === "MethodDefinition") {
      const body = source.slice(node.start, node.end);
      if (node.key.name === "getNetworkPolicy" &&
          body.includes("this.config.readRequirements()") && body.includes("this.config.readAll()")) readsPolicy = true;
      if (node.key.name === "attach" && body.includes("networkPolicy:") &&
          body.includes("this.sendSessionRequest(")) forwardsPolicy = true;
    }
    if (node.type === "CallExpression" && node.callee.type === "MemberExpression" &&
        node.callee.property.name === "attach" && node.arguments[1]?.type === "AwaitExpression" &&
        source.slice(node.arguments[1].start, node.arguments[1].end).includes("this.readNetworkPolicy()")) attachesPolicy = true;
  });
  if (!readsPolicy || !forwardsPolicy || !attachesPolicy) {
    throw new Error(`${label}: 缺少完整 networkPolicy 协议，请先同步兼容的上游资源`);
  }
}

/**
 * 找到真正实现 networkPolicy 协议的服务文件。
 * 先查 browser-service.mjs，再查 browser-service-core.mjs；都没有且目录内也没有服务样式的文件时
 * 说明是纯客户端目录，返回 null；发现改名的服务文件则明确报错，避免静默漏装。
 * @param {string} sourceDirectory 上游运行时目录
 * @param {string} [label] 报错时展示的目录标签
 * @returns {string | null} 通过协议校验的服务文件路径
 */
function resolveServiceImplementation(sourceDirectory, label = sourceDirectory) {
  const candidates = SERVICE_FILES
    .map((name) => path.join(sourceDirectory, name))
    .filter((file) => fs.existsSync(file));
  if (candidates.length === 0) {
    // 上游若再次改名，不能把真正的服务文件当作纯客户端目录静默跳过。
    const unknown = fs.existsSync(sourceDirectory)
      ? fs
          .readdirSync(sourceDirectory)
          .filter((name) => /^browser-service.*\.(?:mjs|js)$/.test(name))
      : [];
    if (unknown.length > 0) {
      throw new Error(
        `${label}: 发现未知的浏览器服务文件名（${unknown.join(", ")}），请先同步匹配的上游运行时`,
      );
    }
    return null;
  }
  const failures = [];
  for (const file of candidates) {
    try {
      assertNetworkPolicySupport(fs.readFileSync(file, "utf8"), label);
      return file;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, `${label}: 缺少完整 networkPolicy 协议，请先同步兼容的上游资源`);
}

function planRepair({ sourceRoot = path.join(SRC_DIR, "win"), resourcesRoot, codexHome }) {
  if (!resourcesRoot) throw new Error("必须指定 --resources");
  const plan = [];
  const validated = new Set();
  function addDirectory(sourceDirectory, destinationDirectory) {
    // 上游各目录布局不同，只同步实际存在的已知产物，不要求六件套齐全。
    const files = RUNTIME_FILES.filter((name) => fs.existsSync(path.join(sourceDirectory, name)));
    if (files.length === 0) throw new Error(`未发现可同步的浏览器运行时文件：${sourceDirectory}`);
    // 安装入口目录必须已存在；目录内缺失的产物按新增处理，允许补进较旧的安装。
    if (!fs.existsSync(destinationDirectory)) {
      throw new Error(`未发现浏览器运行时安装入口：${destinationDirectory}`);
    }
    // 只有存在服务文件时才校验协议；纯客户端目录（如 chrome 插件）没有可校验的协议。
    if (!SERVICE_FILES.some((name) => validated.has(path.join(sourceDirectory, name)))) {
      const service = resolveServiceImplementation(sourceDirectory);
      if (service) validated.add(service);
    }
    for (const name of files) {
      const source = path.join(sourceDirectory, name);
      const file = path.join(destinationDirectory, name);
      const data = fs.readFileSync(source);
      // 旧安装可能还没有上游新增的产物（如拆分后的 core），此时 before 为 null 表示 CREATE。
      const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
      if (name.endsWith(".mjs") || name.endsWith(".js")) {
        parse(data.toString("utf8"), { ecmaVersion: "latest", sourceType: "module" });
      }
      if (before === null || !data.equals(before)) plan.push({ file, data, before });
    }
  }
  for (const directory of RUNTIME_DIRS) {
    addDirectory(path.join(sourceRoot, directory), path.join(resourcesRoot, directory));
  }
  for (const item of planRouting(resourcesRoot)) {
    if (item.changed) plan.push({ file: item.file, data: Buffer.from(item.source), before: fs.readFileSync(item.file) });
  }
  if (codexHome) {
    const cache = path.join(codexHome, "plugins/cache/openai-bundled");
    for (const plugin of ["browser", "chrome", "computer-use"]) {
      const directory = path.join(cache, plugin);
      if (!fs.existsSync(directory)) continue;
      for (const version of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!version.isDirectory() || !/^\d+(?:\.\d+)+$/.test(version.name)) continue;
        const pluginRoot = path.join(directory, version.name);
        if (plugin !== "computer-use") {
          addDirectory(path.join(sourceRoot, "plugins/openai-bundled/plugins", plugin, "scripts"), path.join(pluginRoot, "scripts"));
        } else {
          const file = path.join(pluginRoot, "skills/computer-use/SKILL.md");
          const before = fs.readFileSync(file);
          const result = patchSource(before.toString("utf8"), "skill");
          if (result.changed) plan.push({ file, before, data: Buffer.from(result.source) });
        }
      }
    }
  }
  return plan;
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function applyRepair(plan, backupRoot, write = fs.writeFileSync) {
  if (plan.length === 0) return null;
  // 先检查计划是否过期，再保存全部旧内容；备份失败时不会触碰目标。
  for (const item of plan) {
    // 新增文件没有旧内容可比对，目录存在性已在计划阶段校验。
    if (item.before === null) continue;
    if (!fs.readFileSync(item.file).equals(item.before)) throw new Error(`目标已变化，请重新检查：${item.file}`);
  }
  fs.mkdirSync(backupRoot, { recursive: true });
  const backup = fs.mkdtempSync(path.join(backupRoot, "browser-"));
  const manifest = plan.map((item, index) => {
    // 新增文件无备份内容，用 null 记录，回滚时删除而不是写回 null。
    const name = item.before === null ? null : `${index}.bak`;
    if (name) fs.writeFileSync(path.join(backup, name), item.before);
    return {
      file: item.file,
      backup: name,
      beforeSha256: item.before === null ? null : sha256(item.before),
      afterSha256: sha256(item.data),
    };
  });
  fs.writeFileSync(path.join(backup, "manifest.json"), JSON.stringify(manifest, null, 2));
  const touched = [];
  try {
    for (const item of plan) {
      touched.push(item);
      write(item.file, item.data);
      if (!fs.readFileSync(item.file).equals(item.data)) throw new Error(`写入校验失败：${item.file}`);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const item of touched.reverse()) {
      try {
        if (item.before === null) {
          if (fs.existsSync(item.file)) fs.unlinkSync(item.file);
        } else {
          fs.writeFileSync(item.file, item.before);
        }
      } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    throw new AggregateError([error, ...rollbackErrors], `浏览器修复失败；${rollbackErrors.length ? "部分回滚失败" : "已回滚"}；备份：${backup}`);
  }
  return backup;
}

function main() {
  const args = process.argv.slice(2);
  const options = { check: false };
  const flags = { "--resources": "resourcesRoot", "--source": "sourceRoot", "--codex-home": "codexHome" };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--check") options.check = true;
    else if (flags[flag] && args[index + 1] && !args[index + 1].startsWith("--")) options[flags[flag]] = path.resolve(args[++index]);
    else throw new Error(`未知或不完整参数：${flag}`);
  }
  const plan = planRepair(options);
  for (const item of plan) console.log(`[${options.check ? "?" : "*"}] ${item.file}`);
  const backup = options.check ? null : applyRepair(plan, path.resolve(options.resourcesRoot, "..", "browser-runtime-backups"));
  console.log(`[ok] ${plan.length} file(s) ${options.check ? "require update" : "updated"}${backup ? `; backup: ${backup}` : ""}`);
}

if (require.main === module) main();
module.exports = { RUNTIME_DIRS, RUNTIME_FILES, assertNetworkPolicySupport, resolveServiceImplementation, planRepair, applyRepair };
