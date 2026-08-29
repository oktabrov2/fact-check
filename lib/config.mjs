import fs from "node:fs";
import path from "node:path";

export const PROJECT_ROOT = process.cwd();
export const DATA_DIR = path.join(PROJECT_ROOT, "data");
export const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");

function unquote(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function readEnvironmentFile(filePath = path.join(PROJECT_ROOT, "environment.env")) {
  if (!fs.existsSync(filePath)) return {};

  const values = {};
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    values[match[1]] = unquote(match[2]);
  }
  return values;
}

export function loadConfig(overrides = {}) {
  const fileValues = readEnvironmentFile();
  const valueFor = (key) => overrides[key] ?? process.env[key] ?? fileValues[key] ?? "";
  const parsedPort = Number.parseInt(valueFor("PORT"), 10);
  const adminEmail = valueFor("ADMIN_EMAIL") || valueFor("ADMIN_USER") || valueFor("ADMIN_USERNAME");

  return {
    apiKey: valueFor("OPENAI_API_KEY") || valueFor("api_key"),
    databaseUrl: valueFor("DATABASE_URL"),
    databaseSsl: valueFor("DATABASE_SSL"),
    databaseSslRejectUnauthorized: valueFor("DATABASE_SSL_REJECT_UNAUTHORIZED"),
    adminEmail,
    adminUsername: adminEmail,
    adminPassword: valueFor("ADMIN_PASSWORD"),
    adminPasswordRotate: /^(1|true|yes)$/i.test(valueFor("ADMIN_PASSWORD_ROTATE")),
    donationProvider: valueFor("DONATION_PROVIDER") || "Secure payment provider",
    donationUrl: valueFor("DONATION_URL"),
    model: valueFor("OPENAI_MODEL") || "gpt-5",
    port: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3000,
    nodeEnv: valueFor("NODE_ENV") || "development",
  };
}

export function ensureDirectories() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
}
