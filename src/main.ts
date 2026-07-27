import path from "node:path";
import { config } from "./config.js";
import { EpisodicMemory } from "./memory.js";
import { MinecraftRuntime } from "./runtime.js";

const memory = new EpisodicMemory(path.join(config.dataDir, "memory.sqlite"));
const runtime = new MinecraftRuntime(memory);

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[main] Received ${signal}; shutting down`);
  runtime.stop();
  setTimeout(() => {
    memory.close();
    process.exit(0);
  }, 500);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
  console.error("[main] Uncaught exception", error);
  memory.record({
    kind: "process_error",
    summary: `Uncaught exception: ${error.message}`,
    importance: 10
  });
});
process.on("unhandledRejection", (reason) => {
  console.error("[main] Unhandled rejection", reason);
  memory.record({
    kind: "process_error",
    summary: `Unhandled rejection: ${String(reason)}`,
    importance: 10
  });
});

runtime.start();
