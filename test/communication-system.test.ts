import { describe, expect, it, vi } from "vitest";
import { MineflayerCommunicationSystem } from "../src/communication-system.js";

describe("communication authority", () => {
  it("owns chat and whisper output with protocol-safe message bounds", () => {
    const bot = { chat: vi.fn(), whisper: vi.fn() };
    const communication = new MineflayerCommunicationSystem(bot as never);

    communication.say("x".repeat(300));
    communication.whisper("mason", "hello");

    expect(bot.chat).toHaveBeenCalledWith("x".repeat(240));
    expect(bot.whisper).toHaveBeenCalledWith("mason", "hello");
  });
});
