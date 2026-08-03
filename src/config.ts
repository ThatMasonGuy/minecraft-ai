import "dotenv/config";
import path from "node:path";
import { z } from "zod";
import { PLANNER_MODES } from "./planner-mode.js";

const booleanFromString = (defaultValue: boolean) =>
  z
    .preprocess(
      (value) => value ?? String(defaultValue),
      z.enum(["true", "false"])
    )
    .transform((value) => value === "true");

const schema = z.object({
  OPENAI_API_KEY: z.string().min(20),
  OPENAI_MODEL: z.string().default("gpt-5.6-luna"),
  OPENAI_REASONING_EFFORT: z
    .enum(["none", "low", "medium", "high", "xhigh"])
    .default("low"),
  PLANNER_MODE: z.enum(PLANNER_MODES).default("manual"),
  PLANNER_TOOL_MODE: z.enum(["dry_run", "execute"]).default("dry_run"),
  WEB_SEARCH_ENABLED: booleanFromString(false),
  MC_HOST: z.string().default("localhost"),
  MC_PORT: z.coerce.number().int().min(1).max(65535).default(25565),
  MC_USERNAME: z.string().min(1).default("minecraft-ai"),
  MC_AUTH: z.enum(["microsoft", "offline"]).default("microsoft"),
  MC_VERSION: z.string().optional(),
  VIEWER_ENABLED: booleanFromString(true),
  VIEWER_PORT: z.coerce.number().int().min(1).max(65535).default(3007),
  VIEWER_DISTANCE: z.coerce.number().int().min(2).max(8).default(3),
  VIEWER_MAX_FPS: z.coerce.number().int().min(10).max(60).default(30),
  VIEWER_MAX_PIXEL_RATIO: z.coerce.number().min(0.5).max(2).default(1.25),
  OPERATOR_ENABLED: booleanFromString(true),
  OPERATOR_HOST: z.string().min(1).default("127.0.0.1"),
  OPERATOR_PORT: z.coerce.number().int().min(1).max(65535).default(3008),
  DATA_DIR: z.string().default("./data"),
  AGENT_TICK_MS: z.coerce.number().int().min(10_000).default(5_400_000),
  PERCEPTION_DISTANCE: z.coerce.number().min(4).max(64).default(32),
  MAX_MOVE_DISTANCE: z.coerce.number().min(4).max(256).default(64),
  MAX_TOOL_ROUNDS: z.coerce.number().int().min(1).max(20).default(2),
  WORK_EXECUTOR_TICK_MS: z.coerce.number().int().min(1_000).default(3_000),
  MAX_OUTPUT_TOKENS: z.coerce.number().int().min(64).max(8_192).default(512),
  DAILY_TOKEN_BUDGET: z.coerce.number().int().min(10_000).default(1_000_000),
  DAILY_TOKEN_RESERVE: z.coerce.number().int().min(0).default(150_000),
  RECONNECT_DELAY_MS: z.coerce.number().int().min(1_000).default(10_000),
  ALLOW_PLAYER_COMBAT: booleanFromString(false)
});

const parsed = schema.parse(process.env);

export const config = {
  openaiApiKey: parsed.OPENAI_API_KEY,
  openaiModel: parsed.OPENAI_MODEL,
  reasoningEffort: parsed.OPENAI_REASONING_EFFORT,
  plannerMode: parsed.PLANNER_MODE,
  plannerToolMode: parsed.PLANNER_TOOL_MODE,
  webSearchEnabled: parsed.WEB_SEARCH_ENABLED,
  minecraft: {
    host: parsed.MC_HOST,
    port: parsed.MC_PORT,
    username: parsed.MC_USERNAME,
    auth: parsed.MC_AUTH,
    version: parsed.MC_VERSION?.trim() || undefined
  },
  viewerEnabled: parsed.VIEWER_ENABLED,
  viewerPort: parsed.VIEWER_PORT,
  viewerDistance: parsed.VIEWER_DISTANCE,
  viewerMaxFps: parsed.VIEWER_MAX_FPS,
  viewerMaxPixelRatio: parsed.VIEWER_MAX_PIXEL_RATIO,
  operatorEnabled: parsed.OPERATOR_ENABLED,
  operatorHost: parsed.OPERATOR_HOST,
  operatorPort: parsed.OPERATOR_PORT,
  dataDir: path.resolve(parsed.DATA_DIR),
  tickMs: parsed.AGENT_TICK_MS,
  perceptionDistance: parsed.PERCEPTION_DISTANCE,
  maxMoveDistance: parsed.MAX_MOVE_DISTANCE,
  maxToolRounds: parsed.MAX_TOOL_ROUNDS,
  workExecutorTickMs: parsed.WORK_EXECUTOR_TICK_MS,
  maxOutputTokens: parsed.MAX_OUTPUT_TOKENS,
  dailyTokenBudget: parsed.DAILY_TOKEN_BUDGET,
  dailyTokenReserve: Math.min(
    parsed.DAILY_TOKEN_RESERVE,
    parsed.DAILY_TOKEN_BUDGET
  ),
  reconnectDelayMs: parsed.RECONNECT_DELAY_MS,
  allowPlayerCombat: parsed.ALLOW_PLAYER_COMBAT
} as const;
