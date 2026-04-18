/**
 * channels.ts — Channel registry mapping Telegram chat IDs to session configs.
 *
 * Each channel gets:
 * - A persistent session ID (create-once, resume-forever)
 * - An absolute path to its settings.json (hooks, tool profiles)
 * - Metadata (name, owner, allowed users)
 */

import { randomUUID } from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

export interface ChannelConfig {
  /** Human-readable channel name */
  name: string;
  /** Persistent session ID for claude -p --resume */
  sessionId: string;
  /** Whether the session has been created at least once */
  sessionExists: boolean;
  /** Absolute path to this channel's settings.json */
  settingsPath: string;
  /** Working directory for claude -p spawns (defaults to project root) */
  cwd?: string;
  /** Telegram user IDs allowed to interact in this channel */
  allowedUsers: number[];
  /** Channel description for logging */
  description: string;
}

interface ChannelRegistryData {
  channels: Record<
    string,
    {
      name: string;
      sessionId: string;
      sessionExists: boolean;
      settingsPath: string;
      cwd?: string;
      allowedUsers: number[];
      description: string;
    }
  >;
}

const PROJECT_ROOT = join(new URL("../", import.meta.url).pathname);
const BOT_MODE = process.env.BOT_MODE ?? "prod";
const REGISTRY_FILE = BOT_MODE === "sandbox"
  ? "channel-registry-sandbox.json"
  : "channel-registry-prod.json";
const REGISTRY_PATH = join(PROJECT_ROOT, "bot", REGISTRY_FILE);

let registry: ChannelRegistryData | null = null;

function loadRegistry(): ChannelRegistryData {
  if (registry) return registry;

  if (existsSync(REGISTRY_PATH)) {
    registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
  } else {
    registry = { channels: {} };
  }
  return registry!;
}

function saveRegistry(): void {
  if (!registry) return;
  const dir = join(PROJECT_ROOT, "bot");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");
}

export function getChannel(chatId: number | string): ChannelConfig | null {
  const data = loadRegistry();
  const key = String(chatId);
  const ch = data.channels[key];
  if (!ch) return null;
  return { ...ch };
}

export function registerChannel(
  chatId: number | string,
  config: Omit<ChannelConfig, "sessionId" | "sessionExists"> & {
    sessionId?: string;
  }
): ChannelConfig {
  const data = loadRegistry();
  const key = String(chatId);

  const existing = data.channels[key];
  const sessionId = config.sessionId ?? existing?.sessionId ?? randomUUID();
  const sessionExists = existing?.sessionExists ?? false;

  data.channels[key] = {
    name: config.name,
    sessionId,
    sessionExists,
    settingsPath: config.settingsPath,
    allowedUsers: config.allowedUsers,
    description: config.description,
  };

  saveRegistry();
  return { ...data.channels[key] };
}

export function markSessionCreated(chatId: number | string): void {
  const data = loadRegistry();
  const key = String(chatId);
  if (data.channels[key]) {
    data.channels[key].sessionExists = true;
    saveRegistry();
  }
}

export function resetSession(chatId: number | string): void {
  const data = loadRegistry();
  const key = String(chatId);
  if (data.channels[key]) {
    data.channels[key].sessionId = randomUUID();
    data.channels[key].sessionExists = false;
    saveRegistry();
  }
}

export function listChannels(): Array<{ chatId: string } & ChannelConfig> {
  const data = loadRegistry();
  return Object.entries(data.channels).map(([chatId, ch]) => ({
    chatId,
    ...ch,
  }));
}

export function isUserAllowed(
  chatId: number | string,
  userId: number
): boolean {
  const ch = getChannel(chatId);
  if (!ch) return false;
  // Empty allowedUsers means everyone is allowed
  if (ch.allowedUsers.length === 0) return true;
  return ch.allowedUsers.includes(userId);
}
