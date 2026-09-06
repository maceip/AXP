import { main } from "../../src/cli.js";

const signals = ["SIGINT", "SIGTERM"] as const;
const before = signals.map((signal) => process.listenerCount(signal));
process.on("message", () => process.emit("SIGINT"));
try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  process.send?.({
    before,
    after: signals.map((signal) => process.listenerCount(signal)),
  });
  process.disconnect();
}
