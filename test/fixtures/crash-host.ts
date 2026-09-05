import { readFile } from "node:fs/promises";
import { Hub } from "../../src/hub.js";
import type { HubOptions } from "../../src/hub.js";
const hub = new Hub(
  JSON.parse(await readFile(process.argv[2]!, "utf8")) as HubOptions,
);
process.send!({ url: await hub.listen() });
process.on("message", () => {
  // Deliberately leave a write transaction open, then let the test SIGKILL us.
  hub.store.db.exec(
    "BEGIN IMMEDIATE; INSERT INTO receipts VALUES('crash','uncommitted','fingerprint','null')",
  );
  process.send!({ uncommitted: true });
});
