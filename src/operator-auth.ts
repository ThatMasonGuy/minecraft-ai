import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TOKEN_FILE = "operator-token";
const MINIMUM_TOKEN_LENGTH = 32;

export function loadOrCreateOperatorToken(
  dataDir: string,
  configuredToken?: string
): string {
  const configured = configuredToken?.trim();
  if (configured) return validateToken(configured, "OPERATOR_TOKEN");

  fs.mkdirSync(dataDir, { recursive: true });
  const tokenPath = path.join(dataDir, TOKEN_FILE);
  if (fs.existsSync(tokenPath)) {
    return validateToken(fs.readFileSync(tokenPath, "utf8").trim(), tokenPath);
  }

  const token = randomBytes(32).toString("hex");
  try {
    fs.writeFileSync(tokenPath, `${token}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return validateToken(fs.readFileSync(tokenPath, "utf8").trim(), tokenPath);
  }
}

function validateToken(token: string, source: string): string {
  if (token.length < MINIMUM_TOKEN_LENGTH) {
    throw new Error(`${source} must contain at least ${MINIMUM_TOKEN_LENGTH} characters`);
  }
  return token;
}
