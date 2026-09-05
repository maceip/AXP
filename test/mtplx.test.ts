import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { MtplxClient, MtplxDistiller } from "../src/mtplx.js";

test("MTPLX adapter uses stable isolated session headers and reports actual cache usage", async (t) => {
  const seen: { headers: Record<string, unknown>; body: unknown }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req)
      chunks.push(Buffer.from(chunk as Uint8Array));
    seen.push({
      headers: req.headers,
      body: JSON.parse(Buffer.concat(chunks).toString()) as unknown,
    });
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                '[{"title":"Parser","trigger":"parser edits","lesson":"Keep the return type","outcome":"failure"}]',
            },
          },
        ],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 100,
          prompt_tokens_details: { cached_tokens: seen.length === 1 ? 0 : 800 },
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new MtplxClient(`http://127.0.0.1:${address.port}`);
  const session = {
    owner: "alice",
    sessionId: "s",
    contextRevision: 0,
    identity: {
      repository: "repo",
      baseCommit: "a".repeat(40),
      model: "qwen4exp",
      tokenizer: "tok",
      template: "chat",
      runtime: "mtplx/2",
      format: "local",
    },
  };
  const first = await client.complete(
    session,
    [{ role: "user", content: "one" }],
    100,
    new AbortController().signal,
  );
  const second = await client.complete(
    session,
    [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ],
    100,
    new AbortController().signal,
  );
  assert.equal(first.cache.hit, false);
  assert.equal(second.cache.cachedTokens, 800);
  assert.equal(
    seen[0]?.headers["x-mtplx-session-id"],
    seen[1]?.headers["x-mtplx-session-id"],
  );
  assert.equal(seen[0]?.headers["x-mtplx-restore-mode"], "clone");
  assert.notEqual(
    client.sessionKey({ ...session, owner: "bob" }),
    client.sessionKey(session),
  );
  assert.notEqual(
    client.sessionKey({ ...session, contextRevision: 1 }),
    client.sessionKey(session),
  );
  const distiller = new MtplxDistiller(client, session);
  assert.equal(
    (
      await distiller.extract({
        transcript: "The parser edit broke the API.",
        signal: new AbortController().signal,
      })
    )[0]?.outcome,
    "failure",
  );
});
