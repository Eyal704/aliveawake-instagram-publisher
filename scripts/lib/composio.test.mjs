import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveComposioResult } from "./composio.mjs";

test("accepts a normal inline response", async () => {
  const result = await resolveComposioResult({ successful: true, data: { id: "123" } }, "TEST_TOOL");
  assert.equal(result.data.id, "123");
});

test("loads an offloaded response before accessing data", async (t) => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "composio-result-test-"));
  t.after(() => fs.rm(tempDirectory, { recursive: true, force: true }));
  const outputFilePath = path.join(tempDirectory, "result.json");
  await fs.writeFile(outputFilePath, JSON.stringify({ successful: true, data: { data: [{ id: "media-1" }] } }));

  const result = await resolveComposioResult({ storedInFile: true, outputFilePath }, "TEST_TOOL");
  assert.equal(result.data.data[0].id, "media-1");
});

test("fails loudly when resolution still has no data key", async () => {
  await assert.rejects(
    resolveComposioResult({ successful: true }, "TEST_TOOL"),
    /no data key/,
  );
});

test("fails loudly when storedInFile has no path", async () => {
  await assert.rejects(
    resolveComposioResult({ storedInFile: true }, "TEST_TOOL"),
    /without an outputFilePath/,
  );
});
