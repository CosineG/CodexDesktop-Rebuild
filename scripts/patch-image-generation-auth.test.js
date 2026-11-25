const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { parse } = require("smol-toml");

const {
  patchSource,
  locateTargets,
  RUNTIME_FILENAME,
  RUNTIME_REQUIRE,
  syncRuntimeFiles,
} = require("./patch-image-generation-auth");
const {
  ACTOR_HEADER,
  API_KEY_ENV,
  defaultModelCatalogUrl,
  resolvePatch,
  withImageGenerationAuth,
} = require("./runtime/image-generation-auth.cjs");

function createBundle() {
  return [
    "const providerBase=[{configKey:`openai_base_url`,envVar:`CODEX_APP_SERVER_OPENAI_BASE_URL`}];",
    "var base=[`-c`,`features.code_mode_host=true`];",
    "function args(){let e=providerBase.flatMap(()=>[]);",
    "return e.length===0?[...base,`app-server`,`--analytics-default-enabled`]:",
    "[`app-server`,...base,...e,`--analytics-default-enabled`]} ",
  ].join("");
}

function createRuntime(t, config, auth = null, env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-imagegen-auth-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, "config.toml"), config);
  if (auth != null) {
    fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify(auth));
  }
  return {
    env: { CODEX_HOME: home, ...env },
    homedir: () => home,
    join: (...parts) => path.join(...parts),
    parseToml: parse,
    readFile: (file) => fs.readFileSync(file, "utf8"),
  };
}

test("app-server 参数工厂只补两处基础参数展开", () => {
  const result = patchSource(createBundle());

  assert.equal(result.status, "patched");
  assert.equal(result.count, 2);
  assert.equal(
    result.source.split(RUNTIME_REQUIRE).length - 1,
    2,
  );
  assert.equal(patchSource(result.source).status, "already-patched");
});

test("未知上游参数结构会明确失败", () => {
  const source = createBundle().replace("...base,...e", "...e");
  assert.equal(patchSource(source).status, "unexpected-spread-count");
});

test("重复出现的 app-server 参数 bundle 全部定位并补丁", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-imagegen-build-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const buildDir = path.join(root, "win", "_asar", ".vite", "build");
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(path.join(buildDir, "app-server-host.js"), createBundle());
  fs.writeFileSync(
    path.join(buildDir, "early-bootstrap-824-x.js"),
    createBundle(),
  );
  fs.writeFileSync(path.join(buildDir, "unrelated.js"), "console.log(1);");

  const targets = locateTargets("win", root);

  assert.deepEqual(
    targets.map((target) => path.basename(target.path)).sort(),
    ["app-server-host.js", "early-bootstrap-824-x.js"],
  );
  assert.equal(new Set(targets.map((target) => target.buildDir)).size, 1);
  for (const target of targets) {
    assert.equal(
      patchSource(fs.readFileSync(target.path, "utf8")).status,
      "patched",
    );
  }
});

test("平台有 build 目录但零命中时明确报错", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-imagegen-build-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const buildDir = path.join(root, "win", "_asar", ".vite", "build");
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(path.join(buildDir, "unrelated.js"), "console.log(1);");

  assert.throws(
    () => locateTargets("win", root),
    /no app-server argument bundle found/,
  );
});

test("自定义 base_url 的 API key 通过环境传递并启用受限能力", (t) => {
  const runtime = createRuntime(
    t,
    [
      'model_provider = "My.Provider"',
      '[model_providers."My.Provider"]',
      'name = "OpenAI"',
      'base_url = "https://gateway.example.test/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = true",
    ].join("\n"),
    { auth_mode: "apikey", OPENAI_API_KEY: "test-secret" },
    { WSLENV: "EXISTING/u" },
  );
  const baseArgs = ["-c", "features.code_mode_host=true"];
  const result = withImageGenerationAuth(baseArgs, runtime);

  assert.deepEqual(baseArgs, ["-c", "features.code_mode_host=true"]);
  assert.equal(runtime.env[API_KEY_ENV], "test-secret");
  assert.match(runtime.env.WSLENV, new RegExp(`(?:^|:)${API_KEY_ENV}(?::|$)`));
  assert.ok(result.includes("features.image_generation=true"));
  assert.ok(result.includes("features.api_key_model_discovery=true"));
  assert.ok(
    result.includes(
      'model_providers."My.Provider".model_catalog_url="https://gateway.example.test/v1/models"',
    ),
  );
  assert.ok(
    result.includes(
      'model_providers."My.Provider".requires_openai_auth=false',
    ),
  );
  assert.ok(
    result.includes(
      `model_providers."My.Provider".http_headers.${ACTOR_HEADER}="api-key"`,
    ),
  );
  assert.ok(
    result.includes(
      `model_providers."My.Provider".env_key="${API_KEY_ENV}"`,
    ),
  );
  assert.equal(result.some((arg) => arg.includes("test-secret")), false);
});

test("官方地址、非 API-key 认证和显式禁用全部能力时保持上游行为", (t) => {
  const cases = [
    {
      config: [
        'model_provider = "OpenAI"',
        "[model_providers.OpenAI]",
        'base_url = "https://api.openai.com/v1"',
        "requires_openai_auth = true",
      ].join("\n"),
      auth: { auth_mode: "apikey", OPENAI_API_KEY: "unused" },
    },
    {
      config: [
        'model_provider = "OpenAI"',
        "[model_providers.OpenAI]",
        'base_url = "https://gateway.example.test"',
        "requires_openai_auth = true",
      ].join("\n"),
      auth: { auth_mode: "chatgpt", OPENAI_API_KEY: "unused" },
    },
    {
      config: [
        'model_provider = "OpenAI"',
        "[features]",
        "image_generation = false",
        "api_key_model_discovery = false",
        "[model_providers.OpenAI]",
        'base_url = "https://gateway.example.test"',
        "requires_openai_auth = true",
      ].join("\n"),
      auth: { auth_mode: "apikey", OPENAI_API_KEY: "unused" },
    },
  ];

  for (const entry of cases) {
    const runtime = createRuntime(t, entry.config, entry.auth);
    assert.equal(resolvePatch(runtime), null);
    assert.equal(runtime.env[API_KEY_ENV], undefined);
  }
});

test("静态模型目录优先，远端发现不会覆盖用户配置", (t) => {
  const runtime = createRuntime(
    t,
    [
      'model_provider = "proxy"',
      'model_catalog_json = "C:/configured/models.json"',
      "[model_providers.proxy]",
      'base_url = "https://gateway.example.test/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = true",
    ].join("\n"),
    { auth_mode: "apikey", OPENAI_API_KEY: "test-secret" },
  );
  const patch = resolvePatch(runtime);

  assert.ok(patch);
  assert.ok(patch.overrides.includes("features.image_generation=true"));
  assert.equal(
    patch.overrides.some((value) => value.includes("api_key_model_discovery")),
    false,
  );
  assert.equal(
    patch.overrides.some((value) => value.includes("model_catalog_url")),
    false,
  );
});

test("显式模型目录地址会被保留", (t) => {
  const runtime = createRuntime(
    t,
    [
      'model_provider = "proxy"',
      "[features]",
      "image_generation = false",
      "[model_providers.proxy]",
      'base_url = "https://gateway.example.test/v1"',
      'model_catalog_url = "https://catalog.example.test/codex/models"',
      "requires_openai_auth = true",
    ].join("\n"),
    { auth_mode: "apikey", OPENAI_API_KEY: "test-secret" },
  );
  const patch = resolvePatch(runtime);

  assert.ok(patch);
  assert.deepEqual(
    patch.overrides.filter((value) => value.includes("model_catalog_url")),
    [],
  );
  assert.ok(patch.overrides.includes("features.api_key_model_discovery=true"));
  assert.equal(
    patch.overrides.some((value) => value.includes(ACTOR_HEADER)),
    false,
  );
});

test("默认模型目录地址跟随 provider base_url", () => {
  assert.equal(
    defaultModelCatalogUrl("https://gateway.example.test/v1/?ignored=yes#hash"),
    "https://gateway.example.test/v1/models",
  );
  assert.equal(
    defaultModelCatalogUrl("http://127.0.0.1:8080"),
    "http://127.0.0.1:8080/models",
  );
});

test("已有 provider 环境认证时只补能力标记", (t) => {
  const runtime = createRuntime(
    t,
    [
      'model_provider = "proxy"',
      "[model_providers.proxy]",
      'base_url = "http://127.0.0.1:8080/v1"',
      "requires_openai_auth = false",
      'env_key = "PROXY_TOKEN"',
    ].join("\n"),
    null,
    { PROXY_TOKEN: "existing-secret" },
  );
  const patch = resolvePatch(runtime);

  assert.ok(patch);
  assert.equal(runtime.env[API_KEY_ENV], undefined);
  assert.equal(patch.overrides.some((value) => value.includes("env_key=")), false);
});

test("打包运行时在没有 node_modules 时使用随包 TOML 解析器", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-imagegen-isolated-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(
    path.join(home, "config.toml"),
    [
      'model_provider = "OpenAI"',
      "[model_providers.OpenAI]",
      'base_url = "https://gateway.example.test/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = true",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(home, "auth.json"),
    JSON.stringify({ auth_mode: "api-key", OPENAI_API_KEY: "isolated-secret" }),
  );
  assert.equal(syncRuntimeFiles(root, false), 2);

  const child = spawnSync(
    process.execPath,
    [
      "-e",
      [
        `const m=require(${JSON.stringify(`./${RUNTIME_FILENAME}`)});`,
        'const args=m.withImageGenerationAuth(["app-server"]);',
        "console.log(JSON.stringify({",
        "envSet:Boolean(process.env[m.API_KEY_ENV]),",
        'hasFeature:args.includes("features.image_generation=true"),',
        'hasModelDiscovery:args.includes("features.api_key_model_discovery=true"),',
        "secretInArgs:args.includes(process.env[m.API_KEY_ENV])",
        "}));",
      ].join(""),
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: home, NODE_PATH: "" },
    },
  );

  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    envSet: true,
    hasFeature: true,
    hasModelDiscovery: true,
    secretInArgs: false,
  });
});
