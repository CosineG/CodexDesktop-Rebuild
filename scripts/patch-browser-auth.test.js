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

// Reduced from the bundled browser/chrome service in macOS 26.1007.21159.
function createFeatureGateService(identityPromise, gateValue = true) {
  return [
    `let identity=${identityPromise};`,
    `async function readBrowserFeatureGate(name,deadline){`,
    `if(identity==null)throw new Error("Browser feature gates require caller identity.");`,
    `let value=identity.then(()=>checkGate(name));`,
    `if(deadline==null)return value;`,
    `let timer;`,
    `try{return await Promise.race([value,new Promise((resolve,reject)=>{`,
    `timer=setTimeout(()=>reject(new Error("Timed out waiting for browser feature gate.")),Math.max(0,deadline-Date.now()))`,
    `})])}finally{if(timer!==undefined)clearTimeout(timer)}`,
    `}`,
    `function checkGate(){return ${gateValue}}`,
    `class BrowserTransport{`,
    `constructor(readRequestHeaderEnabled){this.readRequestHeaderEnabled=readRequestHeaderEnabled}`,
    `async sendSessionRequest(){return {agent_request_header_enabled:await this.readRequestHeaderEnabled()}}`,
    `}`,
    `const browser=new BrowserTransport(()=>readBrowserFeatureGate("codex_browser_use_agent_request_header"));`,
  ].join("");
}

function loadFeatureGateService(source) {
  return Function(`${source};return {browser,readBrowserFeatureGate}`)();
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

test("26.1007 浏览器命令在 API-key 身份失败时继续发送且不放行其他开关", async () => {
  const result = patchSource(createFeatureGateService(
    `Promise.reject(new Error("unsupported Codex auth method: apikey"))`,
  ));
  const { browser, readBrowserFeatureGate } = loadFeatureGateService(result.source);

  assert.deepEqual(await browser.sendSessionRequest(), {
    agent_request_header_enabled: false,
  });
  await assert.rejects(
    readBrowserFeatureGate("another_browser_gate"),
    /unsupported Codex auth method: apikey/,
  );
  assert.equal(patchSource(result.source).status, "already-patched");
});

test("26.1007 浏览器命令保留 ChatGPT request-header 开关的返回值", async () => {
  for (const enabled of [true, false]) {
    const result = patchSource(createFeatureGateService("Promise.resolve()", enabled));
    const { browser } = loadFeatureGateService(result.source);

    assert.deepEqual(await browser.sendSessionRequest(), {
      agent_request_header_enabled: enabled,
    });
  }
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
