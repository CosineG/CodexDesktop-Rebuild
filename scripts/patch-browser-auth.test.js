const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { locateTargets, patchSource } = require("./patch-browser-auth");

const NATIVE_CORE_SOURCE =
  "class Preferences{constructor(config){this.config=config}async getExtensionRequestHeaders(){return(await this.config.readRequirements())?.requirements?.browserUse?.extension?.requestHeaders}}";
const LAUNCHER_SOURCE = [
  'var y="./browser-service-core.mjs",i=()=>import(y);',
  "async function handleRpc(t){return(await i()).handleRpc(t)}",
  "export{handleRpc};",
].join("");

function createService(identityPromise, gateValue = true) {
  return [
    `let identity=${identityPromise};`,
    `async function readGate(){`,
    `if(identity==null)throw new Error("Browser request-header policy requires caller identity.");`,
    `return await identity,checkGate("codex_browser_use_agent_request_header")`,
    `}`,
    `function checkGate(){return ${gateValue}}`,
  ].join("");
}

function loadReadGate(source) {
  return Function(`${source};return readGate`)();
}

test("API-key 身份读取失败时关闭 request header 并继续", async () => {
  const result = patchSource(
    createService(`Promise.reject(new Error("unsupported Codex auth method: apikey"))`),
  );

  assert.equal(result.status, "patched");
  assert.equal(await loadReadGate(result.source)(), false);
  assert.equal(patchSource(result.source).status, "already-patched");
});

test("ChatGPT 身份可用时保留原有 Statsig 开关", async () => {
  const enabled = patchSource(createService("Promise.resolve()", true));
  const disabled = patchSource(createService("Promise.resolve()", false));

  assert.equal(await loadReadGate(enabled.source)(), true);
  assert.equal(await loadReadGate(disabled.source)(), false);
});

test("未知上游结构会明确失败而不是静默漏补", () => {
  const source = [
    `async function readGate(){`,
    `throw new Error("Browser request-header policy requires caller identity.");`,
    `checkGate("codex_browser_use_agent_request_header")`,
    `}`,
  ].join("");

  assert.equal(patchSource(source).status, "unexpected-shape");
});

test("新版直接读取组织请求头无需身份认证，并保留策略读取失败", async () => {
  const source = NATIVE_CORE_SOURCE;
  const result = patchSource(source);
  assert.equal(result.status, "native");
  assert.equal(result.source, source);
  const Preferences = Function(`${source};return Preferences`)();
  const headers = [{ name: "X-Managed", value: "enabled" }];
  const configured = new Preferences({ readRequirements: async () => ({ requirements: { browserUse: { extension: { requestHeaders: headers } } } }) });
  assert.deepEqual(await configured.getExtensionRequestHeaders(), headers);
  assert.equal(await new Preferences({ readRequirements: async () => null }).getExtensionRequestHeaders(), undefined);
  await assert.rejects(new Preferences({ readRequirements: async () => { throw new Error("policy unavailable"); } }).getExtensionRequestHeaders(), /policy unavailable/);
});

test("新版 launcher 不含 caller-identity 闸门时标记 not-applicable", () => {
  assert.equal(patchSource(LAUNCHER_SOURCE).status, "not-applicable");
  assert.equal(patchSource(NATIVE_CORE_SOURCE).status, "native");
});

test("无闸门且非启动器的结构明确失败", () => {
  const source = "export const config={revision:2};export function handleRpc(){return null}";
  assert.equal(patchSource(source).status, "unexpected-shape");
});

test("原生实现允许空白差异", () => {
  const source = [
    "class Preferences {",
    "  constructor(config) { this.config = config }",
    "  async   getExtensionRequestHeaders( ) {",
    "    return ( await this.config.readRequirements( ) )?.requirements?.browserUse?.extension?.requestHeaders",
    "  }",
    "}",
  ].join("\n");
  assert.equal(patchSource(source).status, "native");
});

test("递归定位浏览器 runtime，同时发现核心实现与 launcher", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-browser-auth-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const cuaDir = path.join(
    root,
    "win/cua_node/lib/node_modules/@oai/browser-desktop/scripts",
  );
  const pluginDir = path.join(
    root,
    "win/plugins/openai-bundled/plugins/browser/scripts",
  );
  fs.mkdirSync(cuaDir, { recursive: true });
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(cuaDir, "browser-service.mjs"), LAUNCHER_SOURCE);
  fs.writeFileSync(path.join(cuaDir, "browser-service-core.mjs"), NATIVE_CORE_SOURCE);
  fs.writeFileSync(path.join(pluginDir, "browser-service.mjs"), NATIVE_CORE_SOURCE);

  const targets = locateTargets("win", root);

  assert.deepEqual(
    targets.map((target) => path.basename(target.path)),
    ["browser-service-core.mjs", "browser-service.mjs", "browser-service.mjs"],
  );
  assert.deepEqual(
    targets.map((target) => patchSource(fs.readFileSync(target.path, "utf8")).status),
    ["native", "not-applicable", "native"],
  );
});
