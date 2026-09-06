import { workspaceFixture } from "../test/workspace-fixture.js";

const fixture = await workspaceFixture();
try {
  console.log(`Demo workspace with sample data: ${await fixture.open()}`);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
} finally {
  await fixture.close();
}
