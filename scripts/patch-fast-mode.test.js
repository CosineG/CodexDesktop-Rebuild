const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const { patchSource } = require("./patch-fast-mode");

test("局部变量形式的排除判断只额外放行 apikey", () => {
  const source = [
    `async function fastModeEnabled(){`,
    `let n=await getAuthMethod();`,
    `if(n!==\`chatgpt\`)return!1;`,
    `return requirements.fast_mode!==!1`,
    `}`,
  ].join("");

  const result = patchSource(source);

  assert.equal(result.status, "patched");
  assert.match(result.source, /n!==`chatgpt`&&n!==`apikey`/);
  assert.equal(patchSource(result.source).status, "already-patched");
});

test("肯定判断同时允许 chatgpt 与 apikey", () => {
  const source =
    "function canUseFastMode(auth){return auth.authMethod===`chatgpt`&&requirements.fast_mode!==!1}";

  const result = patchSource(source);

  assert.equal(result.status, "patched");
  assert.match(
    result.source,
    /auth\.authMethod===`chatgpt`\|\|auth\.authMethod===`apikey`/,
  );
  assert.equal(patchSource(result.source).status, "already-patched");
});

test("fast_mode 函数之外的认证判断保持不变", () => {
  const source = "function unrelated(n){return n!==`chatgpt`}";

  const result = patchSource(source);

  assert.equal(result.status, "not-applicable");
  assert.equal(result.source, source);
});

test("认证扩展保留 fast_mode 显式关闭的优先级", () => {
  const source = "function allowed(auth){return auth===`chatgpt`&&requirements.fast_mode!==!1}";
  const result = patchSource(source);
  for (const enabled of [false, true]) {
    const allowed = vm.runInNewContext(`${result.source};allowed`, {
      requirements: { fast_mode: enabled },
    });
    assert.equal(allowed("chatgpt"), enabled);
    assert.equal(allowed("apikey"), enabled);
    assert.equal(allowed("unknown"), false);
  }
});

test("新版读取保存的速度设置允许 API key 并保留其他认证分支", async () => {
  const source = "function create(client){return{async readServiceTier(){let r=await client.getAccount();return r.account?.type===`chatgpt`||r.account?.type===`amazonBedrock`}}}";
  const result = patchSource(source);
  assert.equal(result.status, "patched");
  const create = vm.runInNewContext(`${result.source};create`);
  for (const type of ["chatgpt", "apikey", "amazonBedrock", "unknown"]) {
    const client = create({ getAccount: async () => ({ account: { type } }) });
    assert.equal(await client.readServiceTier(), type !== "unknown");
  }
  assert.equal(patchSource(result.source).status, "already-patched");
});

test("首页 fast mode 提示中的 chatgpt 产品类型不能被误改", () => {
  const source = "function beacon(product){return{codex_fast_mode_eligible:product===`chatgpt`&&enabled}}";
  const result = patchSource(source);
  assert.equal(result.status, "not-applicable");
  assert.equal(result.source, source);
});

test("新版界面速度权限允许 API key，保留加载状态与服务端限制", () => {
  // 该入口不再直接包含 fast_mode 字段，由下游函数解析服务端要求。
  const source = [
    "function access(auth,data,pending){",
    "const allowed=auth?.authMethod===`chatgpt`||auth?.authMethod===`personalAccessToken`||auth?.authMethod===`amazonBedrock`;",
    "const isLoading=!!auth?.isLoading||allowed&&pending;",
    "return{serviceTierAccess:allowed&&!isLoading&&data!=null?readAccess(data):null,isLoading}",
    "}",
  ].join("");
  const result = patchSource(source);
  assert.equal(result.status, "patched");
  assert.equal(result.patches.length, 1);
  const access = vm.runInNewContext(`${result.source};access`, {
    readAccess: (data) => ({ fast: data.fast_mode !== false }),
  });
  for (const authMethod of ["chatgpt", "apikey", "personalAccessToken", "amazonBedrock"]) {
    for (const fast_mode of [false, true, undefined]) {
      const state = access({ authMethod }, { fast_mode }, false);
      assert.equal(state.serviceTierAccess.fast, fast_mode !== false);
      assert.equal(state.isLoading, false);
    }
    assert.equal(access({ authMethod, isLoading: true }, {}, false).serviceTierAccess, null);
    assert.equal(access({ authMethod }, {}, true).serviceTierAccess, null);
    assert.equal(access({ authMethod }, null, false).serviceTierAccess, null);
  }
  assert.equal(access({ authMethod: "unknown" }, {}, false).serviceTierAccess, null);
  assert.equal(access(null, {}, false).serviceTierAccess, null);
  assert.equal(patchSource(result.source).status, "already-patched");
});

test("消费速度权限的模型菜单保留其自身的账户限制", () => {
  const source = "function choose(auth,input){const{serviceTierAccess:access,isLoading}=input;return auth.authMethod===`chatgpt`&&!isLoading&&access}";
  const result = patchSource(source);
  assert.equal(result.status, "not-applicable");
  assert.equal(result.source, source);
});
