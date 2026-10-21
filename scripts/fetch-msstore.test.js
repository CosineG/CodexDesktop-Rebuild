const test = require("node:test");
const assert = require("node:assert/strict");

const { getDownloadUrl, withRetry } = require("./fetch-msstore");

test("临时请求失败后会重试并返回结果", async () => {
  let attempts = 0;

  const result = await withRetry(
    async () => {
      attempts++;
      if (attempts < 3) throw new Error("Request timeout");
      return "ok";
    },
    { maxAttempts: 3, retryDelayMs: 0 }
  );

  assert.equal(result, "ok");
  assert.equal(attempts, 3);
});

test("请求持续失败时达到次数上限后抛出最后一个错误", async () => {
  let attempts = 0;

  await assert.rejects(
    withRetry(
      async () => {
        attempts++;
        throw new Error(`failure-${attempts}`);
      },
      { maxAttempts: 3, retryDelayMs: 0 }
    ),
    /failure-3/
  );

  assert.equal(attempts, 3);
});

test("商店暂时返回空文件列表时重试同一更新", async () => {
  let calls = 0;
  const url = await getDownloadUrl("update-1", "1", "Retail", "expected", {
    retryDelayMs: 0,
    request: async (_url, body) => {
      assert.match(body, /<UpdateID>update-1<\/UpdateID>/);
      return { status: 200, body: ++calls === 1 ? "<Result/>" :
        "<Result><FileLocation><FileDigest>expected</FileDigest><Url>https://example.com/app.msix</Url></FileLocation></Result>" };
    },
  });
  assert.equal(url, "https://example.com/app.msix");
  assert.equal(calls, 2);
});

test("摘要不匹配时不能回退到其他安装包或差分文件", async () => {
  await assert.rejects(getDownloadUrl("update-1", "1", "Retail", "expected", {
    maxAttempts: 1, retryDelayMs: 0,
    request: async () => ({ status: 200, body:
      "<Result><FileLocation><FileDigest>different</FileDigest><Url>https://example.com/other.msix</Url></FileLocation></Result>" }),
  }), /摘要匹配/);
});
