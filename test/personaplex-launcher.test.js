const { test } = require("node:test");
const assert = require("node:assert/strict");
const personaplex = require("../personaplex-launcher");

test("cloudUrlConfigured requires PERSONAPLEX_SERVER_URL", () => {
  assert.equal(personaplex.cloudUrlConfigured({}), false);
  assert.equal(personaplex.cloudUrlConfigured({ PERSONAPLEX_SERVER_URL: "  " }), false);
  assert.equal(
    personaplex.cloudUrlConfigured({ PERSONAPLEX_SERVER_URL: "https://gpu.example:8998" }),
    true
  );
});

test("wsUrl points at local bridge", () => {
  assert.match(personaplex.wsUrl(), /^ws:\/\/127\.0\.0\.1:\d+\/v1\/voice$/);
});
