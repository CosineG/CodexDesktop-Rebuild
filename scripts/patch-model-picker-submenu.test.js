const test = require("node:test");
const assert = require("node:assert/strict");

const { patchSource } = require("./patch-model-picker-submenu");

function createBundle(extraProps = "", trailingProps = "") {
  return [
    "function renderPicker(input){",
    `const {ariaLabel:aria,label:label,value:value,children:children,disabled:disabled,${extraProps}contentClassName:contentClassName,flyoutHeader:flyoutHeader${trailingProps}}=input;`,
    "let inline=submenu;if(nativeInline())return inline;let flyout;",
    "return flyout;",
    "}",
  ].join("");
}

for (const [name, source] of [
  ["旧版参数结构", createBundle()],
  ["含 labelOnly 的新版参数结构", createBundle("labelOnly:labelOnly,")],
  [
    "含 onOpenChange 的新版参数结构",
    createBundle("labelOnly:labelOnly,", ",onOpenChange:onOpenChange"),
  ],
]) {
  test(`模型选择器子菜单补丁兼容${name}`, () => {
    const result = patchSource(source);

    assert.equal(result.status, "patched");
    assert.match(
      result.source,
      /if\(label\?\.props\?\.\[`data-model-picker-model-row`\]===!0\|\|typeof nativeInline===`function`&&nativeInline\(\)\)/,
    );
    assert.equal(patchSource(result.source).status, "already-patched");
  });
}

test("模型选择器子菜单补丁拒绝缺失标签锚点的结构", () => {
  const source = createBundle().replace("label:label,", "");
  const result = patchSource(source);

  assert.equal(result.status, "unexpected-row-props-count");
  assert.equal(result.count, 0);
});

test("上游改用点击切换模型列表时保持新选择器不变", () => {
  const source = "const props={'data-model-picker-view-toggle':true,'data-model-picker-view':'models',label:'composer.modelPicker.modelList.open.ariaLabel',onSelectModelOption:select};";
  assert.equal(patchSource(source).status, "native");
  assert.equal(patchSource(source).source, source);
  assert.notEqual(patchSource(source.replace("data-model-picker-view-toggle", "unrelated")).status, "native");
});
