const test = require("node:test");
const assert = require("node:assert/strict");

const { patchSource } = require("./patch-browser-auth");

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
  const source = "class Preferences{constructor(config){this.config=config}async getExtensionRequestHeaders(){return(await this.config.readRequirements())?.requirements?.browserUse?.extension?.requestHeaders}}";
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
