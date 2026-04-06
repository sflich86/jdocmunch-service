const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveTursoConfig, probeClient } = require("./lib/db");

test("resolveTursoConfig prefers DATABASE_TURSO_* aliases and enables Turso only when both values exist", () => {
  assert.deepEqual(
    resolveTursoConfig({
      DATABASE_TURSO_DATABASE_URL: "libsql://prod.turso.io",
      DATABASE_TURSO_AUTH_TOKEN: "secret",
    }),
    {
      url: "libsql://prod.turso.io",
      authToken: "secret",
      enabled: true,
    }
  );

  assert.deepEqual(
    resolveTursoConfig({
      TURSO_DATABASE_URL: "libsql://legacy.turso.io",
      TURSO_AUTH_TOKEN: "",
    }),
    {
      url: "libsql://legacy.turso.io",
      authToken: "",
      enabled: false,
    }
  );
});

test("probeClient validates connectivity with a trivial query", async () => {
  const calls = [];
  const fakeClient = {
    async execute(sql) {
      calls.push(sql);
      return { rows: [{ 1: 1 }] };
    },
  };

  const probed = await probeClient(fakeClient);
  assert.equal(probed, fakeClient);
  assert.deepEqual(calls, ["SELECT 1"]);
});
