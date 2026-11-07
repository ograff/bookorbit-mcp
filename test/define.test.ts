import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { registerActionTool } from "../src/tools/define.js";
import { ok } from "../src/util/format.js";
import { connect, mockBookOrbit } from "./helpers/harness.js";

function setup(enableDestructive = true) {
  const mock = mockBookOrbit({
    "DELETE /things/5": { deleted: 5 },
    "GET /things": [1, 2],
  });
  const register = (server: any, ctx: any) =>
    registerActionTool(server, ctx, {
      name: "things",
      title: "Things",
      description: "test",
      actions: {
        list: {
          readOnly: true,
          schema: {},
          run: async (_i, c) => ok(await c.client.get("/things")),
        },
        remove: {
          destructive: true,
          schema: { id: z.number().int() },
          summarize: (i) => `delete thing ${i.id}`,
          run: async (i, c) => ok(await c.client.delete(`/things/${i.id}`)),
        },
      },
    });
  return {
    mock,
    ...{ connect: () => connect(register, mock.client, enableDestructive) },
  };
}

test("destructive action without confirm is a dry run and makes no API call", async () => {
  const { mock, connect } = setup();
  const { call } = await connect();
  const r = await call("things", { action: "remove", id: 5 });
  assert.equal(r.data.dryRun, true);
  assert.equal(r.data.wouldDo, "delete thing 5");
  assert.equal(mock.calls.length, 0);
});

test("confirm: true executes", async () => {
  const { mock, connect } = setup();
  const { call } = await connect();
  const r = await call("things", { action: "remove", id: 5, confirm: true });
  assert.deepEqual(r.data, { deleted: 5 });
  assert.equal(mock.calls[0]!.method, "DELETE");
});

test("ENABLE_DESTRUCTIVE=false refuses even with confirm", async () => {
  const { mock, connect } = setup(false);
  const { call } = await connect();
  const r = await call("things", { action: "remove", id: 5, confirm: true });
  assert.equal(r.isError, true);
  assert.match(r.text, /ENABLE_DESTRUCTIVE=false/);
  assert.equal(mock.calls.length, 0);
});

test("invalid input yields a readable per-action error", async () => {
  const { connect } = setup();
  const { call } = await connect();
  const r = await call("things", { action: "remove" });
  assert.equal(r.isError, true);
  assert.match(r.text, /things\.remove.*id/);
});

test("mixed tool is annotated destructive, not read-only", async () => {
  const { connect } = setup();
  const { mcp } = await connect();
  const tool = (await mcp.listTools()).tools.find((t) => t.name === "things")!;
  assert.equal(tool.annotations?.readOnlyHint, false);
  assert.equal(tool.annotations?.destructiveHint, true);
});
