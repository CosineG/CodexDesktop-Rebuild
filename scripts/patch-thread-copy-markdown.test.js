const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { MARKER, patchSource } = require("./patch-thread-copy-markdown");

const nativeFixture = "async function getComplete(client,id){if(!client)throw Error('Conversation must be resumed before loading history');let result=complete(client.getConversation(id));return result}" +
  "async function renderNative({visibleTurnEntries,cwd,title}){return renderConversationMarkdown(visibleTurnEntries,cwd,title)}" +
  "function visibleNative({conversationRequests,conversationTurns,hasConversation,parentConversationTurns,subagentParentThreadId}){return{visibleTurnEntries:conversationTurns}}" +
  "async function readView(scope,{conversationId,isBackgroundSubagentsEnabled,markdownLimit}){if(excluded(scope.source))return null;let {visibleTurnEntries}=scope.get(conversationId);return renderNative({visibleTurnEntries})}";
const fixture = nativeFixture + "function copy({scope:s,conversationId:id,parentConversationId:parent,getMarkdown:render,intl:i}){" +
  "(async()=>{await manager(s,s.get(host,id)).ensureConversationHistoryLoaded(id,parent==null?[]:[parent]);" +
  "let markdown=await render();markdown!=null&&markdown.trim().length!==0&&await write(markdown)&&" +
  "s.get(toasts).success(i.formatMessage(messages.copyConversationMarkdownSuccess))})().catch(()=>{" +
  "s.get(toasts).danger(i.formatMessage(messages.copyConversationMarkdownError)," +
  "{errorAnalytics:{toastId:'threadActions.copyConversationMarkdown.copyConversationMarkdownError'}})})}";

function harness({ content = "# 会话\n实际历史", clipboard = true, failure, viewLoaded = false, source = "user" } = {}) {
  const result = patchSource(fixture);
  assert.equal(result.status, "patched");
  const calls = [];
  const written = [];
  const notices = [];
  let loaded = false;
  const client = {
    async getConversation() {
      return { content, threadSource: source, requests: [], complete: loaded && failure !== "incomplete" };
    },
    async ensureConversationHistoryLoaded(id, parents, options) {
      calls.push({ id, parents, options });
      if (failure === "history") throw Error("读取历史失败");
      // 模拟尾部加载关闭：未显式 force 时，原生方法直接返回。
      if (options?.force) loaded = true;
    },
  };
  const notify = { success: (value) => notices.push(["success", value]), danger: (value) => notices.push(["danger", value]) };
  const scope = { get: (token) => token === "toasts" ? notify : "local" };
  const copy = vm.runInNewContext(`${result.source};copy`, {
    host: "host", toasts: "toasts", manager: () => client,
    messages: { copyConversationMarkdownSuccess: "复制成功", copyConversationMarkdownError: "复制失败" },
    write: async (text) => {
      if (failure === "clipboard") throw Error("剪贴板占用");
      if (clipboard) written.push(text);
      return clipboard;
    },
    complete: (conversation) => conversation?.complete ? [conversation.content] : null,
    excluded: (value) => value === "unsupported",
    renderConversationMarkdown: (entries) => entries[0],
  });
  const run = (parent) => copy({ scope, conversationId: "thread", parentConversationId: parent,
    getMarkdown: async () => {
      if (failure === "render") throw Error("格式化失败");
      return loaded && viewLoaded ? content : null;
    }, intl: { formatMessage: (value) => value } });
  return { run, calls, written, notices };
}

test("未打开会话先读取完整历史，再写入真实内容并提示成功", async () => {
  const h = harness();
  await h.run();
  assert.equal(h.calls[0].options.force, true);
  assert.equal(h.calls[0].id, "thread");
  assert.equal(h.calls[0].parents.length, 0);
  assert.deepEqual(h.written, ["# 会话\n实际历史"]);
  assert.deepEqual(h.notices, [["success", "复制成功"]]);
});

test("子代理会话保留父会话历史加载参数", async () => {
  const h = harness();
  await h.run("parent-thread");
  assert.equal(h.calls[0].parents[0], "parent-thread");
  assert.deepEqual(h.notices, [["success", "复制成功"]]);
});

test("已加载页面保留原生格式化回调结果", async () => {
  const h = harness({ viewLoaded: true });
  await h.run();
  assert.deepEqual(h.written, ["# 会话\n实际历史"]);
});

test("后台历史不完整时拒绝复制部分内容", async () => {
  const h = harness({ failure: "incomplete" });
  await h.run();
  assert.deepEqual(h.written, []);
  assert.deepEqual(h.notices, [["danger", "复制失败"]]);
});

test("快照回退保留不支持导出的会话类型限制", async () => {
  const h = harness({ source: "unsupported" });
  await h.run();
  assert.deepEqual(h.written, []);
  assert.deepEqual(h.notices, [["danger", "复制失败"]]);
});

for (const content of [null, "", " \n "]) {
  test(`空会话内容 ${JSON.stringify(content)} 显示失败且不覆盖剪贴板`, async () => {
    const h = harness({ content });
    await h.run();
    assert.deepEqual(h.written, []);
    assert.deepEqual(h.notices, [["danger", "复制失败"]]);
  });
}

for (const failure of ["history", "render", "clipboard"]) {
  test(`${failure} 异常沿用原生错误提示`, async () => {
    const h = harness({ failure });
    await h.run();
    assert.deepEqual(h.written, []);
    assert.deepEqual(h.notices, [["danger", "复制失败"]]);
  });
}

test("剪贴板写入返回 false 时显示失败", async () => {
  const h = harness({ clipboard: false });
  await h.run();
  assert.deepEqual(h.written, []);
  assert.deepEqual(h.notices, [["danger", "复制失败"]]);
});

test("补丁重复运行不再修改，保留其他历史加载调用", () => {
  const unrelated = "function unrelated(){return client.ensureConversationHistoryLoaded(id,[])}";
  const first = patchSource(fixture + unrelated);
  const second = patchSource(first.source);
  assert.equal(second.status, "already-patched");
  assert.equal(second.source, first.source);
  assert.equal(first.source.split(MARKER).length, 2);
  assert.ok(first.source.endsWith(unrelated));
});

test("结构改变或目标重复时拒绝猜测性修改", () => {
  const changed = fixture.replace("ensureConversationHistoryLoaded(id,", "differentHistoryLoader(id,");
  assert.equal(patchSource(changed).status, "unsupported-structure");
  assert.equal(patchSource(changed).source, changed);
  assert.equal(patchSource(fixture + fixture.slice(nativeFixture.length).replace("function copy(", "function duplicate(")).status, "ambiguous");
  assert.equal(patchSource(fixture.replace("renderConversationMarkdown(visibleTurnEntries", "changedRenderer(visibleTurnEntries")).status, "unsupported-history-renderer");
});

test("无关或无法解析的文件不修改", () => {
  assert.equal(patchSource("const unrelated = true;").status, "not-applicable");
  assert.equal(patchSource(fixture + "(").status, "parse-error");
});
