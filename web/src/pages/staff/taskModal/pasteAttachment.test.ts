import assert from "node:assert/strict";
import test from "node:test";
import { attachmentFilesFromPaste } from "./pasteAttachment.ts";

test("a nameless screenshot becomes a png the uploader can accept", () => {
  const blob = new File([new Uint8Array([1, 2, 3])], "", { type: "image/png" });
  const files = attachmentFilesFromPaste(
    {
      items: [{ kind: "file", type: "image/png", getAsFile: () => blob }],
      getData: () => "",
    },
    null,
  );
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "pasted-image.png");
  assert.equal(files[0].type, "image/png");
});

test("a named jpeg is kept and a pdf is ignored", () => {
  const photo = new File([new Uint8Array([1])], "photo.jpg", { type: "image/jpeg" });
  const pdf = new File([new Uint8Array([1])], "notes.pdf", { type: "application/pdf" });
  const files = attachmentFilesFromPaste({ files: [photo, pdf] }, null);
  assert.deepEqual(files.map((file) => file.name), ["photo.jpg"]);
});

test("text pasted into a comment stays in the comment", () => {
  const field = { closest: () => field };
  const files = attachmentFilesFromPaste(
    {
      items: [{ kind: "file", type: "image/png", getAsFile: () => new File([new Uint8Array([1])], "image.png", { type: "image/png" }) }],
      getData: (type: string) => (type === "text/plain" ? "ship the fix" : ""),
    },
    field as unknown as EventTarget,
  );
  assert.equal(files.length, 0);
});

test("an image pasted into a text field is still attached", () => {
  const field = { closest: () => field };
  const files = attachmentFilesFromPaste(
    {
      items: [{ kind: "file", type: "image/webp", getAsFile: () => new File([new Uint8Array([1])], "blob", { type: "" }) }],
      getData: () => "",
    },
    field as unknown as EventTarget,
  );
  assert.equal(files[0]?.name, "pasted-image.webp");
  assert.equal(files[0]?.type, "image/webp");
});
