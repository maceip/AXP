import { workspaceFixture } from "../test/workspace-fixture.js";

const fixture = await workspaceFixture();
try {
  console.log(
    `Demo workspace (deterministic sample data): ${await fixture.open()}`,
  );
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
} finally {
  await fixture.close();
}
