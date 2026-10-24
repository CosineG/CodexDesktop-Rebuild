const test = require("node:test");
const assert = require("node:assert/strict");
const acorn = require("acorn");
const vm = require("node:vm");

const {
  DIRECT_ACTION_ID,
  LEGACY_MARKER,
  MARKER,
  SIDEBAR_MARKER,
  hasSidebarMenuSignatures,
  hasNativeDirectAction,
  patchSidebarSource,
  patchSource,
  selectTargets,
} = require("./patch-thread-file-manager-action");

function createGroupedMenuBundle(options = {}) {
  const openHelper = options.includeOpenHelper === false
    ? ""
    : [
        "function openItem(input){",
        "let{scope,appPath,openInSidePanel,cwd,hostId,path,",
        "persistPreferredTargetPath,target,openMode}=input;",
        "if(target!=null||openMode===`workspace`||persistPreferredTargetPath!=null){",
        "scope.open({path,cwd,hostId,target,appPath});return}",
        "if(openInSidePanel)scope.open({path,cwd,hostId,target:`fileManager`})",
        "}",
      ].join("");
  const menuBuilder = [
    "function buildOpenItems({scope:s,cwd:c,hostId:h}){",
    "let request={cwd:c,hostId:h,path:void 0};",
    "let data=s.query.getData(targets,request);",
    "s.query.fetch(targets,request).catch(()=>{});",
    "let report=()=>`localConversation.openTarget.error`;",
    "return makeOpenMenu({",
    "targets:data?.targets.map(item=>item),",
    "message:`localConversationPage.openPrimaryTarget`,",
    "onOpenInTarget:(target,appPath)=>{",
    "s.get(openMutation).mutate({path:c,cwd:c,hostId:h,target,appPath,",
    "openMode:`workspace`,persistPreferredTargetPath:c},{onError:report})",
    "}",
    "})",
    "}",
    ...(options.includeCopySignature === false
      ? []
      : ["const copyMessage=`threadHeader.copyActions`;"]),
  ].join("");
  return openHelper + menuBuilder;
}

function evaluatePatchedMenu(source, platform, options = {}) {
  const context = {
    navigator: { userAgentData: { platform } },
    targets: {},
    openMutation: {},
    opened: null,
    makeOpenMenu: (input) => [{ id: "open-workspace-in", icon: "open-icon", onOpenInTarget: input.onOpenInTarget }],
  };
  context.scope = {
    get: () => ({
      mutate(params) { context.opened = params; },
      async mutateAsync(params) {
        if (options.reject) throw new Error("测试打开失败");
        context.opened = params;
        return { success: options.success !== false };
      },
    }),
    // 侧边栏只有全局作用域，预览函数不能在这里读取任务作用域。
    getOwnValue() { throw new Error("Missing scope instance"); },
    open() { throw new Error("不能通过文件预览函数打开目录"); },
    query: {
      fetch: () => Promise.resolve(),
      setData() { context.preferredTargetChanged = true; },
      getData: () => ({
        targets: [{ target: "fileManager", resolvedIcon: "folder-icon" }],
      }),
    },
  };
  context.ensureWorkspace = async () => { context.resolvedWorkspace = "C:\\最新工作树"; };
  context.resolveWorkspace = (fallback) => context.resolvedWorkspace ?? fallback;
  context.reportError = () => { context.reportedErrors = (context.reportedErrors ?? 0) + 1; };
  vm.runInNewContext(
    `${source};result=buildOpenItems({scope,cwd:\`C:\\\\repo\`,hostId:\`local\`})`,
    context,
  );
  return context;
}

function createSidebarMenuBundle() {
  return [
    "function buildThreadMenu({scope:s,target:t}){",
    "let{conversationId:id,hostId:h,cwd:c}=t,items=[];",
    "let primary=[{id:`rename-thread`},{id:`archive-thread`}];",
    "return c!=null&&!getState(s.get,`remote_control_connections`)",
    "?.some(item=>item.hostId===h)&&s.get(gitBacked,id)",
    "&&items.push(...buildOpenItems({scope:s,cwd:normalize(c),hostId:h})),",
    "items.push({id:`open-in-new-window`}),",
    "[...primary,...items]",
    "}",
  ].join("");
}

function createSelectorSidebarMenuBundle() {
  return [
    "let sidebarGate=derive(store,({conversationId:id,hostId:h},{get:g})=>",
    "id!=null&&g(gitBacked,id)&&!getState(g,`remote_control_connections`)",
    "?.some(item=>item.hostId===h));",
    "function buildThreadMenu({scope:s,target:t}){",
    "let{conversationId:id,hostId:h,cwd:c}=t,items=[];",
    "let primary=[{id:`rename-thread`},{id:`archive-thread`}];",
    "return c!=null&&s.get(sidebarGate,{conversationId:id,hostId:h})",
    "&&items.push(...buildOpenItems({scope:s,cwd:normalize(c),hostId:h})),",
    "items.push({id:`open-in-new-window`}),",
    "[...primary,...items]",
    "}",
  ].join("");
}

function evaluatePatchedSidebar(source, options = {}) {
  const context = {
    gitBacked: {},
    getState: () => options.remoteConnections ?? [],
    derive: (_store, selector) => selector,
    store: {},
    normalize: (cwd) => cwd,
    buildOpenItems: () => [{ id: DIRECT_ACTION_ID }],
    scope: {
      get: (value, argument) =>
        typeof value === "function"
          ? value(argument, { get: () => false })
          : false,
    },
  };
  vm.runInNewContext(
    `${source};result=buildThreadMenu({scope,target:{` +
      `conversationId:\`thread-1\`,hostId:\`local\`,cwd:${
        options.cwd === null ? "null" : "`C:\\\\repo`"
      }}})`,
    context,
  );
  return context.result;
}

test("新版对话菜单增加顶层文件管理器入口并保留打开方式子菜单", () => {
  const result = patchSource(createGroupedMenuBundle());

  assert.equal(result.status, "patched");
  assert.ok(result.source.includes(MARKER));
  assert.ok(result.source.includes(`id:\`${DIRECT_ACTION_ID}\``));
  assert.match(
    result.source,
    /onSelect:\(\)=>__codexOpenWorkspaceInTarget\(`fileManager`\)/,
  );
  assert.match(
    result.source,
    /sidebarElectron\.openWorkspaceRootInExplorer/,
  );
  assert.match(result.source, /navigator\?\.userAgentData\?\.platform/);
  assert.match(result.source, /\.toLowerCase\(\)/);
  assert.match(result.source, /\.startsWith\(`mac`\)/);
  assert.match(result.source, /\.\.\.__codexOpenWorkspaceItems/);
  assert.doesNotThrow(() =>
    acorn.parse(result.source, {
      ecmaVersion: "latest",
      sourceType: "module",
    }),
  );
});

test("候选识别不依赖上游已移除的复制动作签名", () => {
  const source = createGroupedMenuBundle({ includeCopySignature: false });

  assert.equal(source.includes("threadHeader.copyActions"), false);
  assert.equal(patchSource(source).status, "patched");
});

test("侧边栏普通目录会话不再受 Git 仓库门控", () => {
  const original = createSidebarMenuBundle();
  const result = patchSidebarSource(original);

  assert.equal(result.status, "patched");
  assert.ok(result.source.includes(SIDEBAR_MARKER));
  assert.doesNotMatch(result.source, /s\.get\(gitBacked,id\)/);
  assert.equal(
    evaluatePatchedSidebar(result.source).some(
      (item) => item.id === DIRECT_ACTION_ID,
    ),
    true,
  );
  assert.doesNotThrow(() =>
    acorn.parse(result.source, {
      ecmaVersion: "latest",
      sourceType: "module",
    }),
  );
});

test("侧边栏入口仍要求工作目录且排除远程控制连接", () => {
  const { source } = patchSidebarSource(createSidebarMenuBundle());

  assert.equal(
    evaluatePatchedSidebar(source, { cwd: null }).some(
      (item) => item.id === DIRECT_ACTION_ID,
    ),
    false,
  );
  assert.equal(
    evaluatePatchedSidebar(source, {
      remoteConnections: [{ hostId: "local" }],
    }).some((item) => item.id === DIRECT_ACTION_ID),
    false,
  );
});

test("兼容 26.908 将 Git 限制移入派生选择器的结构", () => {
  const result = patchSidebarSource(createSelectorSidebarMenuBundle());

  assert.equal(result.status, "patched");
  assert.ok(result.source.includes(`!0${SIDEBAR_MARKER}`));
  assert.doesNotMatch(result.source, /g\(gitBacked,id\)/);
  assert.equal(
    evaluatePatchedSidebar(result.source).some(
      (item) => item.id === DIRECT_ACTION_ID,
    ),
    true,
  );
  assert.equal(
    evaluatePatchedSidebar(result.source, {
      remoteConnections: [{ hostId: "local" }],
    }).some((item) => item.id === DIRECT_ACTION_ID),
    false,
  );
});

test("兼容 26.911 将侧边栏菜单合并到 app-initial 的结构", () => {
  const original = createGroupedMenuBundle() + createSelectorSidebarMenuBundle();

  assert.equal(hasSidebarMenuSignatures(original), true);
  assert.equal(hasSidebarMenuSignatures(createGroupedMenuBundle()), false);

  const openMenuResult = patchSource(original);
  assert.equal(openMenuResult.status, "patched");

  const sidebarResult = patchSidebarSource(openMenuResult.source);
  assert.equal(sidebarResult.status, "patched");
  assert.ok(sidebarResult.source.includes(MARKER));
  assert.ok(sidebarResult.source.includes(SIDEBAR_MARKER));
  assert.doesNotThrow(() =>
    acorn.parse(sidebarResult.source, {
      ecmaVersion: "latest",
      sourceType: "module",
    }),
  );
});

test("侧边栏补丁重复执行保持幂等", () => {
  const first = patchSidebarSource(createSidebarMenuBundle());
  const second = patchSidebarSource(first.source);

  assert.equal(first.status, "patched");
  assert.equal(second.status, "already-patched");
  assert.equal(second.source, first.source);
});

test("侧边栏结构变化时明确失败而不是静默跳过", () => {
  const result = patchSidebarSource(
    "function changedThreadMenu(){return [{id:`rename-thread`}]}",
  );

  assert.equal(result.status, "unexpected-sidebar-menu-gate-count");
  assert.equal(result.count, 0);
});

test("新版远程连接 selector 仍保留远程排除且允许本地普通目录", () => {
  const original = createSelectorSidebarMenuBundle().replace(
    "getState(g,`remote_control_connections`)", "g(remoteConnections)",
  );
  const result = patchSidebarSource(original);
  assert.equal(result.status, "patched");
  for (const connected of [false, true]) {
    const connections = connected ? [{ hostId: "local" }] : [];
    const context = {
      store: {}, gitBacked: {}, remoteConnections: {},
      derive: (_store, selector) => selector,
    };
    const gate = vm.runInNewContext(`${result.source};sidebarGate`, context);
    assert.equal(gate({ conversationId: "thread", hostId: "local" }, {
      get: (selector) => selector === context.remoteConnections ? connections : false,
    }), !connected);
  }
  assert.equal(patchSidebarSource(result.source).status, "already-patched");
});

test("26.1021 菜单迁到 app-primary 且没有远程配置名时仍应用两类补丁", () => {
  const source = createCurrentWorkspaceBundle() + createSelectorSidebarMenuBundle()
    .replace("getState(g,`remote_control_connections`)", "g(remoteConnections)");
  const bundles = [
    { platform: "win", path: "app-initial-new.js", source: "const initial=true;" },
    { platform: "win", path: "app-primary-new.js", source },
  ];
  assert.equal(source.includes("remote_control_connections"), false);
  const targets = selectTargets(bundles);
  assert.deepEqual(targets.map(({ path, patchKind }) => [path, patchKind]), [
    ["app-primary-new.js", "open-menu"],
    ["app-primary-new.js", "sidebar"],
  ]);

  let patched = source;
  for (const target of targets) {
    const patch = target.patchKind === "sidebar" ? patchSidebarSource : patchSource;
    const result = patch(patched);
    assert.equal(result.status, "patched");
    patched = result.source;
  }
  assert.ok(patched.includes(MARKER));
  assert.ok(patched.includes(SIDEBAR_MARKER));
  const repeated = selectTargets([bundles[0], { ...bundles[1], source: patched }]);
  assert.equal(repeated.length, 2);
  for (const target of repeated) {
    const patch = target.patchKind === "sidebar" ? patchSidebarSource : patchSource;
    assert.equal(patch(target.source).status, "already-patched");
  }
});

test("按平台独立定位菜单并兼容旧版分离的 chunk", () => {
  const targets = selectTargets([
    { platform: "mac-arm64", path: "mac/app-initial.js", source: createGroupedMenuBundle() },
    { platform: "win", path: "win/app-initial.js", source: "const initial=true;" },
    { platform: "mac-arm64", path: "mac/app-primary.js", source: createSidebarMenuBundle() },
    { platform: "win", path: "win/app-primary.js", source: createGroupedMenuBundle() + createSidebarMenuBundle() },
  ]);
  assert.deepEqual(targets.map(({ path, patchKind }) => [path, patchKind]), [
    ["mac/app-initial.js", "open-menu"],
    ["mac/app-primary.js", "sidebar"],
    ["win/app-primary.js", "open-menu"],
    ["win/app-primary.js", "sidebar"],
  ]);
});

test("原生目录入口移到 app-primary 后仍能识别", () => {
  const targets = selectTargets([
    { platform: "win", path: "app-initial.js", source: "const initial=true;" },
    { platform: "win", path: "app-primary.js", source: "const items=[{id:`open-thread-folder`}];" },
  ]);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].path, "app-primary.js");
  assert.equal(patchSource(targets[0].source).status, "native");
});

test("未知菜单结构仍返回待检查目标并明确失败", () => {
  const targets = selectTargets([
    { platform: "win", path: "app-initial.js", source: "const changedMenu=true;" },
    { platform: "win", path: "app-primary.js", source: "const primary=true;" },
  ]);
  assert.equal(targets.length, 1);
  assert.equal(patchSource(targets[0].source).status, "unexpected-menu-builder-count");
});

test("补丁重复执行保持幂等", () => {
  const first = patchSource(createGroupedMenuBundle());
  const second = patchSource(first.source);

  assert.equal(first.status, "patched");
  assert.equal(second.status, "already-patched");
  assert.equal(second.source, first.source);
});

test("顶层入口按系统显示文案并复用 fileManager 打开链路", () => {
  const { source } = patchSource(createGroupedMenuBundle());
  const cases = [
    ["Windows", "sidebarElectron.openWorkspaceRootInExplorer"],
    ["macOS", "sidebarElectron.openWorkspaceRootInFinder"],
    ["Linux", "sidebarElectron.openWorkspaceRootInFileManager"],
  ];

  for (const [platform, messageId] of cases) {
    const context = evaluatePatchedMenu(source, platform);
    assert.equal(context.result[0].id, DIRECT_ACTION_ID);
    assert.equal(context.result[0].message.id, messageId);
    assert.equal(context.result[0].icon, "folder-icon");
    assert.equal(context.result[1].id, "open-workspace-in");

    context.result[0].onSelect();
    assert.equal(context.opened.target, "fileManager");
    assert.equal(context.opened.cwd, "C:\\repo");
    assert.equal(context.opened.persistPreferredTargetPath, undefined);
    assert.equal(context.preferredTargetChanged, undefined);
  }
});

test("旧版已有顶层 open-thread-folder 时安全跳过", () => {
  const source =
    "const items=[{id:`open-thread-folder`,message:folder,onSelect:openFolder}];";

  assert.equal(hasNativeDirectAction(source), true);
  assert.equal(patchSource(source).status, "native");
});

test("新旧菜单实现共存时优先修补新版动作聚合器", () => {
  const source =
    "const legacy=[{id:`open-thread-folder`,onSelect:openFolder}];" +
    createGroupedMenuBundle();
  const result = patchSource(source);

  assert.equal(result.status, "patched");
  assert.ok(result.source.includes(MARKER));
});

test("工作区菜单不再依赖需要任务作用域的预览函数", () => {
  const result = patchSource(createGroupedMenuBundle({ includeOpenHelper: false }));
  assert.equal(result.status, "patched");
  const context = evaluatePatchedMenu(result.source, "Windows");
  assert.doesNotThrow(() => context.result[0].onSelect());
  assert.equal(context.opened.path, "C:\\repo");
});

test("工作区打开回调缺失时拒绝生成没有动作的菜单", () => {
  const original = createGroupedMenuBundle().replace("onOpenInTarget:", "changedOpenHandler:");
  const result = patchSource(original);
  assert.equal(result.status, "missing-workspace-open-callback");
  assert.equal(result.source, original);
});

function createCurrentWorkspaceBundle() {
  return createGroupedMenuBundle().replace(
    "onOpenInTarget:(target,appPath)=>{s.get(openMutation).mutate({path:c,cwd:c,hostId:h,target,appPath,openMode:`workspace`,persistPreferredTargetPath:c},{onError:report})}",
    "onOpenInTarget:async(target,appPath)=>{try{await ensureWorkspace();let cwd=resolveWorkspace(c);s.query.setData(targets,request,data=>({...data,preferredTarget:target}));let result=await s.get(openMutation).mutateAsync({path:cwd,cwd,hostId:h,target,appPath,openMode:`workspace`,persistPreferredTargetPath:cwd});if(!result.success)reportError()}catch(error){reportError()}}",
  );
}

test("新版回调先解析最新工作树，直接打开不改变默认编辑器", async () => {
  const result = patchSource(createCurrentWorkspaceBundle());
  assert.equal(result.status, "patched");
  const context = evaluatePatchedMenu(result.source, "Windows");
  await context.result[0].onSelect();
  assert.equal(context.opened.path, "C:\\最新工作树");
  assert.equal(context.opened.cwd, "C:\\最新工作树");
  assert.equal(context.opened.target, "fileManager");
  assert.equal(context.opened.hostId, "local");
  assert.equal(context.opened.persistPreferredTargetPath, undefined);
  assert.equal(context.preferredTargetChanged, undefined);
  await context.result[1].onOpenInTarget("vscode", "C:\\Code.exe");
  assert.equal(context.preferredTargetChanged, true);
  assert.equal(context.opened.persistPreferredTargetPath, "C:\\最新工作树");
  assert.equal(context.opened.target, "vscode");
});

test("系统打开返回失败或抛异常时保留原生错误提示", async () => {
  const { source } = patchSource(createCurrentWorkspaceBundle());
  for (const options of [{ success: false }, { reject: true }]) {
    const context = evaluatePatchedMenu(source, "Windows", options);
    await context.result[0].onSelect();
    assert.equal(context.reportedErrors, 1);
  }
});

test("已应用旧补丁的菜单原地升级且不会重复插入", () => {
  const source = createGroupedMenuBundle();
  const old = source.replace("return makeOpenMenu({", "let __codexOpenWorkspaceItems=makeOpenMenu({")
    .replace("})}const copyMessage", `});let __codexDesktopPlatform=\`win\`;return[{${LEGACY_MARKER}id:\`${DIRECT_ACTION_ID}\`,onSelect:()=>openItem({scope:s,path:c,cwd:c,hostId:h,target:\`fileManager\`,openMode:\`workspace\`})},...__codexOpenWorkspaceItems]}const copyMessage`);
  assert.ok(old.includes(LEGACY_MARKER));
  const result = patchSource(old);
  assert.equal(result.status, "patched");
  assert.equal(result.source.includes(LEGACY_MARKER), false);
  assert.equal(result.source.split(DIRECT_ACTION_ID).length - 1, 1);
  const context = evaluatePatchedMenu(result.source, "Windows");
  context.result[0].onSelect();
  assert.equal(context.opened.target, "fileManager");
  assert.equal(patchSource(result.source).status, "already-patched");
});
