/// <reference lib="webworker" />
// Reads a spreadsheet off the main thread. The page gives it the bytes and
// gets plain text back (see xlsxRead.ts).
import { readSheets, type WorkerReply } from "./xlsxRead";

self.onmessage = (event: MessageEvent<ArrayBuffer>) => {
  let reply: WorkerReply;
  try {
    reply = { ok: true, sheets: readSheets(event.data) };
  } catch {
    reply = { ok: false };
  }
  self.postMessage(reply);
};
