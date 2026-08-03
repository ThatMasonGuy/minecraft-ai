import type { Bot } from "mineflayer";

export interface CommunicationSystem {
  say(message: string): void;
  whisper(username: string, message: string): void;
}

export class MineflayerCommunicationSystem implements CommunicationSystem {
  constructor(private readonly bot: Bot) {}

  say(message: string): void {
    this.bot.chat(message.slice(0, 240));
  }

  whisper(username: string, message: string): void {
    this.bot.whisper(username, message.slice(0, 240));
  }
}
