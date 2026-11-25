#!/usr/bin/env node
/**
 * 为简体中文推理强度名称补充实际协议参数，并明确 Ultra 的特殊语义。
 *
 * 上游语言包由构建产物生成，文件名包含哈希，直接修改会在下次同步时丢失。
 * 本补丁按稳定的 i18n 消息 ID 定位文本，兼容命名模块与 Rspack JSON 语言包。
 *
 * Usage:
 *   node scripts/patch-reasoning-effort-labels.js [platform]
 *   node scripts/patch-reasoning-effort-labels.js --check
 */
const fs = require("fs");
const path = require("path");
const zlib = require("node:zlib");
const { parse } = require("acorn");
const { SRC_DIR, relPath, listJavaScriptFiles } = require("./patch-util");

const PLATFORMS = ["mac-arm64", "mac-x64", "win"];
const GZIP_SUFFIX = ".json.codex-gzip";
// 新版语言目录：zh-CN.keys.<group>.<hash>.json.codex-gzip
const ZH_CATALOG_PATTERN = /^zh-CN\.keys\.([^.]+)\.[^.]+\.json\.codex-gzip$/;

const TRANSLATION_SPECS = Object.freeze([
  { messageIds: ["composer.mode.local.reasoning.none.label"], translation: "无（none）" },
  { messageIds: ["composer.mode.local.reasoning.minimal.label"], translation: "极低（minimal）" },
  {
    // 26.803 将 low 的消息 ID 升级为 v2；保留旧 ID 以兼容历史安装包。
    messageIds: [
      "composer.mode.local.reasoning.low.label.v2",
      "composer.mode.local.reasoning.low.label",
    ],
    translation: "轻度（low）",
  },
  { messageIds: ["composer.mode.local.reasoning.medium.label"], translation: "中（medium）" },
  { messageIds: ["composer.mode.local.reasoning.high.label"], translation: "高（high）" },
  { messageIds: ["composer.mode.local.reasoning.xhigh.label"], translation: "极高（xhigh）" },
  { messageIds: ["composer.mode.local.reasoning.max.label"], translation: "最高（max）" },
  { messageIds: ["composer.mode.local.reasoning.ultra.label"], translation: "Ultra（ultra）" },
  {
    messageIds: ["composer.modelPicker.power.ultraUsageWarning"],
    translation: "自动任务委派，更快消耗使用额度",
  },
]);

const TRANSLATIONS = Object.freeze(
  Object.fromEntries(
    TRANSLATION_SPECS.map(({ messageIds, translation }) => [messageIds[0], translation]),
  ),
);

const REASONING_MESSAGE_ID = TRANSLATION_SPECS[0].messageIds[0];

/** 读取 gzip 压缩的 JSON 语言目录；损坏文件返回 null，交由定位逻辑按不匹配处理。 */
function readGzipJson(file) {
  try {
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
  } catch {
    return null;
  }
}

/**
 * 为 <lang>.keys.<group>.<hash> 目录寻找共享 keys 目录。
 * 优先同组 keys；缺失时回退到任意包含推理强度消息的 keys，兼容上游版本漂移。
 */
function findKeysCatalog(localesDir, group, cache) {
  const names = fs
    .readdirSync(localesDir)
    .filter((name) => name.startsWith("keys.") && name.endsWith(GZIP_SUFFIX));
  const preferred = `keys.${group}${GZIP_SUFFIX}`;
  for (const name of [preferred, ...names.filter((item) => item !== preferred)]) {
    const filePath = path.join(localesDir, name);
    if (!fs.existsSync(filePath)) continue;
    let keys = cache.get(filePath);
    if (keys === undefined) {
      keys = readGzipJson(filePath);
      cache.set(filePath, keys);
    }
    if (Array.isArray(keys) && keys.includes(REASONING_MESSAGE_ID)) {
      return { path: filePath, keys };
    }
  }
  return null;
}

/** 定位新版 gzip 语言目录，只返回简体中文目标。 */
function findGzipLocaleTargets(platform, localesDir) {
  if (!fs.existsSync(localesDir)) return { targets: [], missingKeys: false };
  const cache = new Map();
  const targets = [];
  let missingKeys = false;

  for (const name of fs.readdirSync(localesDir)) {
    const match = ZH_CATALOG_PATTERN.exec(name);
    if (!match) continue;
    const keys = findKeysCatalog(localesDir, match[1], cache);
    if (!keys) {
      missingKeys = true;
      continue;
    }
    targets.push({
      platform,
      kind: "gzip",
      path: path.join(localesDir, name),
      keysPath: keys.path,
    });
  }

  return { targets, missingKeys };
}

function escapeTemplateLiteral(value) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
}

function findTemplateLiteralEnd(source, start) {
  for (let index = start; index < source.length; index++) {
    if (source[index] !== "`") continue;

    let backslashes = 0;
    for (let cursor = index - 1; cursor >= start && source[cursor] === "\\"; cursor--) {
      backslashes++;
    }
    if (backslashes % 2 === 0) return index;
  }
  return -1;
}

function findOccurrences(source, marker) {
  const indexes = [];
  let offset = 0;
  while ((offset = source.indexOf(marker, offset)) !== -1) {
    indexes.push(offset);
    offset += marker.length;
  }
  return indexes;
}

function walk(node, visit) {
  if (!node?.type) return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (value?.type) walk(value, visit);
  }
}

function patchJsonLocale(source) {
  if (!source.includes("JSON.parse")) return null;
  const payloads = [];
  walk(parse(source, { ecmaVersion: "latest", sourceType: "module" }), (node) => {
    if (node.type !== "CallExpression" || node.callee.object?.name !== "JSON" ||
        node.callee.property?.name !== "parse" || typeof node.arguments[0]?.value !== "string") return;
    const literal = node.arguments[0];
    const messages = JSON.parse(literal.value);
    if (messages && Object.hasOwn(messages, "composer.mode.local.reasoning.none.label")) {
      payloads.push({ literal, messages });
    }
  });
  if (payloads.length === 0) return null;
  if (payloads.length !== 1) return { status: "unexpected-entry-count", source,
    invalidEntries: [{ messageId: "JSON locale payload", count: payloads.length }] };
  const [{ literal, messages }] = payloads;
  const patches = [], invalidEntries = [];
  for (const { messageIds, translation } of TRANSLATION_SPECS) {
    const candidates = messageIds.filter((id) => Object.hasOwn(messages, id));
    if (candidates.length !== 1 || typeof messages[candidates[0]] !== "string") {
      invalidEntries.push({ messageId: messageIds.join(" or "), count: candidates.length });
      continue;
    }
    const [messageId] = candidates;
    if (messages[messageId] !== translation) {
      patches.push({ messageId, original: messages[messageId], replacement: translation });
      messages[messageId] = translation;
    }
  }
  if (invalidEntries.length) return { status: "unexpected-entry-count", invalidEntries, source };
  if (!patches.length) return { status: "already-patched", patches, source };
  const next = source.slice(0, literal.start) + JSON.stringify(JSON.stringify(messages)) + source.slice(literal.end);
  parse(next, { ecmaVersion: "latest", sourceType: "module" });
  return { status: "patched", patches, source: next };
}

function patchSource(source) {
  const jsonResult = patchJsonLocale(source);
  if (jsonResult) return jsonResult;
  const patches = [];
  const invalidEntries = [];

  for (const { messageIds, translation } of TRANSLATION_SPECS) {
    const candidates = messageIds.flatMap((messageId) => {
      const marker = `"${messageId}":\``;
      return findOccurrences(source, marker).map((offset) => ({ messageId, marker, offset }));
    });
    if (candidates.length !== 1) {
      invalidEntries.push({ messageId: messageIds.join(" or "), count: candidates.length });
      continue;
    }

    const [{ messageId, marker, offset }] = candidates;
    const start = offset + marker.length;
    const end = findTemplateLiteralEnd(source, start);
    if (end === -1) {
      invalidEntries.push({ messageId, count: 0, unterminated: true });
      continue;
    }

    const replacement = escapeTemplateLiteral(translation);
    const original = source.slice(start, end);
    if (original !== replacement) {
      patches.push({ messageId, start, end, original, replacement });
    }
  }

  if (invalidEntries.length > 0) {
    return {
      status: "unexpected-entry-count",
      invalidEntries,
      source,
    };
  }

  if (patches.length === 0) {
    return { status: "already-patched", patches, source };
  }

  let nextSource = source;
  for (const patch of [...patches].sort((a, b) => b.start - a.start)) {
    nextSource =
      nextSource.slice(0, patch.start) +
      patch.replacement +
      nextSource.slice(patch.end);
  }

  try {
    parse(nextSource, { ecmaVersion: "latest", sourceType: "module" });
  } catch (error) {
    return { status: "parse-failed", error, patches, source };
  }

  return { status: "patched", patches, source: nextSource };
}

/**
 * 按消息 ID 修补 gzip 语言目录：keys 与译文数组索引对齐，只改简体中文译文。
 * 写入前执行 gunzip + JSON.parse + 数组长度与目标值回读校验。
 */
function patchLocaleCatalog(catalogBuffer, keysBuffer) {
  let values;
  let keys;
  try {
    values = JSON.parse(zlib.gunzipSync(catalogBuffer));
    keys = JSON.parse(zlib.gunzipSync(keysBuffer));
  } catch (error) {
    return { status: "parse-failed", error, patches: [], source: catalogBuffer };
  }

  if (!Array.isArray(values) || !Array.isArray(keys) || values.length !== keys.length) {
    return {
      status: "unexpected-entry-count",
      invalidEntries: [
        {
          messageId: "locale catalog alignment",
          count: Array.isArray(values) ? values.length : 0,
        },
      ],
      patches: [],
      source: catalogBuffer,
    };
  }

  // 预建消息 ID -> 索引，保证同一 ID 重复出现时能被计为异常。
  const indexes = new Map();
  keys.forEach((messageId, index) => {
    if (typeof messageId !== "string") return;
    const list = indexes.get(messageId);
    if (list) list.push(index);
    else indexes.set(messageId, [index]);
  });

  const patches = [];
  const invalidEntries = [];
  for (const { messageIds, translation } of TRANSLATION_SPECS) {
    const candidates = messageIds.flatMap((messageId) => indexes.get(messageId) ?? []);
    if (candidates.length !== 1) {
      invalidEntries.push({ messageId: messageIds.join(" or "), count: candidates.length });
      continue;
    }

    const [index] = candidates;
    if (typeof values[index] !== "string") {
      invalidEntries.push({
        messageId: messageIds.join(" or "),
        count: 1,
        nonString: true,
      });
      continue;
    }
    if (values[index] !== translation) {
      patches.push({
        messageId: keys[index],
        index,
        original: values[index],
        replacement: translation,
      });
      values[index] = translation;
    }
  }

  if (invalidEntries.length > 0) {
    return { status: "unexpected-entry-count", invalidEntries, patches, source: catalogBuffer };
  }
  if (patches.length === 0) {
    return { status: "already-patched", patches, source: catalogBuffer };
  }

  const next = zlib.gzipSync(Buffer.from(JSON.stringify(values), "utf8"));
  try {
    const roundtrip = JSON.parse(zlib.gunzipSync(next));
    if (!Array.isArray(roundtrip) || roundtrip.length !== values.length) {
      throw new Error("locale catalog length mismatch after gzip roundtrip");
    }
    for (const patch of patches) {
      if (roundtrip[patch.index] !== patch.replacement) {
        throw new Error(`locale catalog value mismatch at index ${patch.index}`);
      }
    }
  } catch (error) {
    return { status: "parse-failed", error, patches, source: catalogBuffer };
  }

  return { status: "patched", patches, source: next };
}

function getPlatforms(platform, srcDir) {
  if (platform) return [platform];
  return PLATFORMS.filter((item) =>
    fs.existsSync(path.join(srcDir, item, "_asar", "webview", "assets")),
  );
}

/** 从真实 locale 导入映射定位中文分片，避免根据翻译文字猜测语言。 */
function findLocaleBundles(assetsDir) {
  const files = listJavaScriptFiles(assetsDir);
  const named = files.filter((file) => /^zh-CN-.*\.js$/.test(path.basename(file)));
  if (named.length) return named;
  const chunkIds = new Set();
  for (const file of files) {
    const source = fs.readFileSync(path.join(assetsDir, file), "utf8");
    if (!source.includes("../locales/zh-CN.json")) continue;
    walk(parse(source, { ecmaVersion: "latest", sourceType: "module" }), (node) => {
      if (node.type !== "Property" || node.key.value !== "../locales/zh-CN.json") return;
      walk(node.value, (call) => {
        if (call.type === "CallExpression" && call.callee.property?.name === "e" &&
            typeof call.arguments[0]?.value === "number") chunkIds.add(String(call.arguments[0].value));
      });
    });
  }
  return files.filter((file) => chunkIds.has(path.basename(file).split(".")[0]));
}

function findTargets(platform, srcDir = SRC_DIR) {
  const targets = [];
  const invalidPlatforms = [];

  for (const currentPlatform of getPlatforms(platform, srcDir)) {
    const assetsDir = path.join(
      srcDir,
      currentPlatform,
      "_asar",
      "webview",
      "assets",
    );

    // 新版优先：语言目录已外置为 gzip JSON，不再经过 JS 加载器。
    const gzip = findGzipLocaleTargets(currentPlatform, path.join(assetsDir, "locales"));
    if (gzip.targets.length > 0) {
      targets.push(...gzip.targets);
      continue;
    }
    if (gzip.missingKeys) {
      invalidPlatforms.push({
        platform: currentPlatform,
        reason: `no keys catalog contains ${REASONING_MESSAGE_ID}`,
      });
      continue;
    }

    // 旧版回退：仍从 JS 语言包中按消息 ID 定位。
    const files = findLocaleBundles(assetsDir);

    if (files.length !== 1) {
      invalidPlatforms.push({ platform: currentPlatform, count: files.length });
      continue;
    }

    targets.push({
      platform: currentPlatform,
      kind: "js",
      path: path.join(assetsDir, files[0]),
    });
  }

  return { invalidPlatforms, targets };
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((item) => PLATFORMS.includes(item));
  const { invalidPlatforms, targets } = findTargets(platform);
  let failed = invalidPlatforms.length;
  let changed = 0;

  for (const item of invalidPlatforms) {
    console.log(
      item.reason
        ? `  [x] ${item.platform}: ${item.reason}`
        : `  [x] ${item.platform}: expected 1 zh-CN bundle, found ${item.count}`,
    );
  }

  if (targets.length === 0 && invalidPlatforms.length === 0) {
    console.log("  [skip] No generated platform sources found");
    return;
  }

  for (const target of targets) {
    const label = relPath(target.path);
    const result =
      target.kind === "gzip"
        ? patchLocaleCatalog(
            fs.readFileSync(target.path),
            fs.readFileSync(target.keysPath),
          )
        : patchSource(fs.readFileSync(target.path, "utf-8"));

    if (result.status === "already-patched") {
      console.log(`  [ok] ${label}: already patched`);
      continue;
    }

    if (result.status === "unexpected-entry-count") {
      for (const entry of result.invalidEntries) {
        const reason = entry.unterminated
          ? "unterminated template literal"
          : entry.nonString
            ? "expected string value"
            : entry.messageId === "locale catalog alignment"
              ? `expected equal array length, found ${entry.count}`
              : `expected 1 entry, found ${entry.count}`;
        console.log(`  [x] ${label}: ${entry.messageId}: ${reason}`);
      }
      failed++;
      continue;
    }

    if (result.status === "parse-failed") {
      console.log(`  [x] ${label}: post-patch parse failed: ${result.error.message}`);
      failed++;
      continue;
    }

    if (isCheck) {
      console.log(
        `  [?] ${label}: would update ${result.patches.length} translation(s)`,
      );
    } else {
      if (target.kind === "gzip") fs.writeFileSync(target.path, result.source);
      else fs.writeFileSync(target.path, result.source, "utf-8");
      console.log(
        `  [ok] ${label}: updated ${result.patches.length} translation(s)`,
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

module.exports = {
  TRANSLATIONS,
  TRANSLATION_SPECS,
  findTargets,
  findLocaleBundles,
  findGzipLocaleTargets,
  patchLocaleCatalog,
  patchSource,
};
