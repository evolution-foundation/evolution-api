import assert from "node:assert/strict";
import { test } from "node:test";

test("stored app-state keys are revived as bytes, not as their base64 text", async () => {
  const { proto } = await import("baileys");
  const stored = JSON.parse(JSON.stringify({ keyData: Buffer.alloc(32, 7).toString("base64"), timestamp: "1791458000000" }));
  const keyData = proto.Message.AppStateSyncKeyData.fromObject(stored).keyData as Uint8Array;
  assert.equal(keyData.length, 32);
  assert.equal(Buffer.from(keyData).equals(Buffer.alloc(32, 7)), true);
  // create() keeps the 44-char base64 string: HKDF over it derives the wrong keys.
  assert.equal(typeof proto.Message.AppStateSyncKeyData.create(stored).keyData, "string");
});
