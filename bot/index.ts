/**
 * index.ts — Telegram ↔ Claude Code bridge
 *
 * Spawns `claude -p` per inbound message and streams the response back
 * to the user as Telegram messages.
 *
 * Out of the box this runs in single-owner mode: set TELEGRAM_OWNER_CHAT_ID
 * to your own Telegram user ID and no one else can talk to your bot.
 */

import "dotenv/config";
import { Bot, Context } from "grammy";
import {
  getChannel,
  markSessionCreated,
  isUserAllowed,
  registerChannel,
  resetSession,
} from "./channels";
import { spawnClaude } from "./spawn";
import { enqueue, setActiveProcess, stopActive, clearQueue, getQueueStatus } from "./queue";
import { join } from "path";
import * as fs from "fs";
import * as os from "os";

const PROJECT_ROOT = join(new URL("../", import.meta.url).pathname);
const BOT_NAME = process.env.BOT_NAME ?? "claude-tg-bot";
const TMP_DIR = process.env.TMP_DIR ?? join(os.tmpdir(), `${BOT_NAME}-files`);
// Optional — if the file is missing, spawn.ts omits the --settings flag.
const SETTINGS_PATH = process.env.CLAUDE_SETTINGS_PATH ?? join(PROJECT_ROOT, ".claude", "settings.json");

// --- Config validation ---

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is required. See .env.example.");
  process.exit(1);
}

const OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID;
if (!OWNER_CHAT_ID) {
  console.warn(
    "[WARN] TELEGRAM_OWNER_CHAT_ID is not set. The bot will accept messages from ANYONE. " +
    "Set this env var to your Telegram user ID to run in single-owner mode."
  );
}

// --- Initialize bot ---

const bot = new Bot(BOT_TOKEN);

// --- Auto-register owner's DM on first message ---

function ensureChannel(chatId: number, userId: number): boolean {
  let channel = getChannel(chatId);

  if (!channel) {
    // Only the configured owner can register channels
    if (OWNER_CHAT_ID && String(userId) !== OWNER_CHAT_ID) {
      console.log(`[AUTH] User ${userId} is not the owner. Ignoring.`);
      return false;
    }

    channel = registerChannel(chatId, {
      name: `DM`,
      settingsPath: SETTINGS_PATH,
      allowedUsers: OWNER_CHAT_ID ? [Number(OWNER_CHAT_ID)] : [],
      description: `Auto-registered ${new Date().toISOString()}`,
    });

    console.log(`[CHANNEL] Registered DM: ${chatId} → session ${channel.sessionId}`);
  }

  if (!isUserAllowed(chatId, userId)) {
    console.log(`[AUTH] User ${userId} not allowed. Ignoring.`);
    return false;
  }

  return true;
}

// --- Stop command ---

bot.on("message:text").filter(
  (ctx) => {
    const text = ctx.message.text.toLowerCase().trim();
    return text === "stop" || text === "/stop" || text === "stop all" || text === "/stop all";
  },
  async (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text.toLowerCase().trim();
    const nuclear = text.includes("all");

    const result = stopActive(chatId);

    if (result.stopped) {
      let clearedCount = 0;
      if (nuclear) {
        clearedCount = clearQueue(chatId);
      }

      const label = result.label.slice(0, 40);
      if (nuclear) {
        await ctx.reply(`🛑 Stopped "${label}" (${Math.round(result.elapsedMs / 1000)}s). Cleared ${clearedCount} queued.`);
      } else {
        const status = getQueueStatus(chatId);
        const nextMsg = status.pendingCount > 0 ? ` Next: "${status.pendingLabels[0]}"` : "";
        await ctx.reply(`🛑 Stopped "${label}" (${Math.round(result.elapsedMs / 1000)}s).${nextMsg}`);
      }
    } else {
      await ctx.reply("Nothing running.");
    }
  }
);

// --- Queue status ---

bot.on("message:text").filter(
  (ctx) => {
    const text = ctx.message.text.toLowerCase().trim();
    return text === "/queue" || text === "/status";
  },
  async (ctx) => {
    const chatId = ctx.chat.id;
    const status = getQueueStatus(chatId);

    if (!status.processing && status.pendingCount === 0) {
      await ctx.reply("Queue empty.");
      return;
    }

    let msg = "";
    if (status.processing) {
      msg += `▶️ Active: "${status.activeLabel}" (${Math.round(status.activeElapsedMs / 1000)}s)\n`;
    }
    if (status.pendingCount > 0) {
      msg += `⏳ Queued (${status.pendingCount}):\n`;
      status.pendingLabels.forEach((l, i) => {
        msg += `  ${i + 1}. ${l}\n`;
      });
    }
    await ctx.reply(msg.trim());
  }
);

// --- Session rotation ---

bot.on("message:text").filter(
  (ctx) => ctx.message.text.trim() === "/rotate",
  async (ctx) => {
    const chatId = ctx.chat.id;
    const userId = ctx.from?.id;
    if (!chatId || !userId || !ensureChannel(chatId, userId)) return;

    const channel = getChannel(chatId)!;
    const oldSessionId = channel.sessionId;
    resetSession(chatId);
    const newChannel = getChannel(chatId)!;

    console.log(`[ROTATE] chat=${chatId} | ${oldSessionId} → ${newChannel.sessionId}`);

    await ctx.reply(
      `✅ Session rotated.\n` +
      `Old: \`${oldSessionId.slice(0, 8)}...\`\n` +
      `New: \`${newChannel.sessionId.slice(0, 8)}...\`\n\n` +
      `Next message starts a fresh Claude Code session.`,
      { parse_mode: "Markdown" }
    );
  }
);

// --- Message handler ---

bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from?.id;
  if (!chatId || !userId) return;

  if (!ensureChannel(chatId, userId)) return;

  const channel = getChannel(chatId)!;
  let messageText = ctx.message.text;
  const msgId = ctx.message.message_id;

  const reply = ctx.message.reply_to_message;
  if (reply) {
    const replyFrom = reply.from?.first_name ?? "someone";
    let replyContext = "";
    if (reply.text) {
      replyContext = `[Replying to ${replyFrom}: "${reply.text}"]`;
    } else if (reply.caption) {
      replyContext = `[Replying to ${replyFrom}'s attachment with caption: "${reply.caption}"]`;
    } else if (reply.photo) {
      replyContext = `[Replying to ${replyFrom}'s photo]`;
    } else if (reply.document) {
      replyContext = `[Replying to ${replyFrom}'s file: ${reply.document.file_name ?? "unknown"}]`;
    } else {
      replyContext = `[Replying to ${replyFrom}'s message]`;
    }
    messageText = `${replyContext}\n\n${messageText}`;
  }

  console.log(`[MSG] ${ctx.from?.first_name}: ${messageText.slice(0, 80)}`);

  enqueue(chatId, msgId, messageText.slice(0, 60), async () => {
    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {});
    }, 4000);
    await ctx.replyWithChatAction("typing").catch(() => {});

    const tracker = new ProgressTracker(ctx);
    tracker.start();

    try {
      const result = await spawnClaude(
        {
          sessionId: channel.sessionId,
          sessionExists: channel.sessionExists,
          settingsPath: channel.settingsPath,
          cwd: channel.cwd,
          message: messageText,
          timeoutMs: 900_000,
          onOutput: (full) => tracker.onOutput(full),
          onEvent: (evt) => tracker.onEvent(evt),
        },
        (child) => setActiveProcess(chatId, child)
      );

      clearInterval(typingInterval);

      if (!channel.sessionExists && result.ok) {
        markSessionCreated(chatId);
      }

      if (result.text) {
        const handled = await tracker.finalize(result.text);
        if (!handled) {
          await sendReply(ctx, result.text);
        } else if (result.text.length > 4000) {
          await sendReply(ctx, result.text.slice(4000));
        }
      } else {
        await tracker.cleanup();
        if (result.exitCode !== 0 && result.exitCode !== 143 && result.exitCode !== 137) {
          console.error(`[ERROR] exit=${result.exitCode}, stderr=${result.stderr.slice(0, 200)}`);
          await ctx.reply("Hit an error. Check the logs.");
        }
      }

      console.log(`[SPAWN] ${result.elapsedMs}ms | exit=${result.exitCode} | ${result.text.length} chars`);
    } catch (err) {
      clearInterval(typingInterval);
      await tracker.cleanup();
      console.error("[ERROR]", err);
      await ctx.reply("Something went wrong. Check the logs.");
    }
  });
});

// --- Photo handler ---

bot.on("message:photo", async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from?.id;
  if (!chatId || !userId || !ensureChannel(chatId, userId)) return;

  const channel = getChannel(chatId)!;
  const photos = ctx.message.photo;
  const bestPhoto = photos[photos.length - 1];
  if (!bestPhoto) return;
  let caption = ctx.message.caption ?? "";
  const msgId = ctx.message.message_id;

  const reply = ctx.message.reply_to_message;
  if (reply) {
    const replyFrom = reply.from?.first_name ?? "someone";
    let replyContext = "";
    if (reply.text) {
      replyContext = `[Replying to ${replyFrom}: "${reply.text}"]`;
    } else if (reply.caption) {
      replyContext = `[Replying to ${replyFrom}'s attachment with caption: "${reply.caption}"]`;
    } else if (reply.photo) {
      replyContext = `[Replying to ${replyFrom}'s photo]`;
    } else if (reply.document) {
      replyContext = `[Replying to ${replyFrom}'s file: ${reply.document.file_name ?? "unknown"}]`;
    } else {
      replyContext = `[Replying to ${replyFrom}'s message]`;
    }
    caption = caption ? `${replyContext}\n\n${caption}` : replyContext;
  }

  console.log(`[PHOTO] ${ctx.from?.first_name}: caption="${caption.slice(0, 60)}"`);

  enqueue(chatId, msgId, `photo: ${caption.slice(0, 40) || "(no caption)"}`, async () => {
    await ctx.replyWithChatAction("typing").catch(() => {});
    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {});
    }, 4000);

    const tracker = new ProgressTracker(ctx);
    tracker.start();

    try {
      const file = await ctx.api.getFile(bestPhoto.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
      fs.mkdirSync(TMP_DIR, { recursive: true });
      const localPath = join(TMP_DIR, `photo-${msgId}.jpg`);

      const resp = await fetch(fileUrl);
      const buf = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(localPath, buf);

      const message = [
        `[Photo received]`,
        caption ? `Caption: "${caption}"` : "(no caption)",
        `Saved to: ${localPath}`,
        ``,
        `The image is available at ${localPath} — use the Read tool to view it if needed.`,
      ].join("\n");

      const result = await spawnClaude(
        {
          sessionId: channel.sessionId,
          sessionExists: channel.sessionExists,
          settingsPath: channel.settingsPath,
          cwd: channel.cwd,
          message,
          timeoutMs: 900_000,
          onOutput: (full) => tracker.onOutput(full),
          onEvent: (evt) => tracker.onEvent(evt),
        },
        (child) => setActiveProcess(chatId, child)
      );

      clearInterval(typingInterval);

      if (!channel.sessionExists && result.ok) {
        markSessionCreated(chatId);
      }

      if (result.text) {
        const handled = await tracker.finalize(result.text);
        if (!handled) {
          await sendReply(ctx, result.text);
        } else if (result.text.length > 4000) {
          await sendReply(ctx, result.text.slice(4000));
        }
      } else {
        await tracker.cleanup();
        if (result.exitCode !== 0 && result.exitCode !== 143 && result.exitCode !== 137) {
          console.error(`[ERROR] exit=${result.exitCode}, stderr=${result.stderr.slice(0, 200)}`);
          await ctx.reply("Hit an error processing the photo.");
        }
      }

      console.log(`[SPAWN] photo | ${result.elapsedMs}ms | exit=${result.exitCode}`);
    } catch (err) {
      clearInterval(typingInterval);
      await tracker.cleanup();
      console.error("[ERROR] photo handler:", err);
      await ctx.reply("Something went wrong with the photo.");
    }
  });
});

// --- Document/file handler ---

bot.on("message:document", async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from?.id;
  if (!chatId || !userId || !ensureChannel(chatId, userId)) return;

  const channel = getChannel(chatId)!;
  const doc = ctx.message.document;
  const fileName = doc.file_name ?? "unknown";
  const mimeType = doc.mime_type ?? "";
  let caption = ctx.message.caption ?? "";
  const msgId = ctx.message.message_id;

  const reply = ctx.message.reply_to_message;
  if (reply) {
    const replyFrom = reply.from?.first_name ?? "someone";
    let replyContext = "";
    if (reply.text) {
      replyContext = `[Replying to ${replyFrom}: "${reply.text}"]`;
    } else if (reply.caption) {
      replyContext = `[Replying to ${replyFrom}'s attachment with caption: "${reply.caption}"]`;
    } else if (reply.photo) {
      replyContext = `[Replying to ${replyFrom}'s photo]`;
    } else if (reply.document) {
      replyContext = `[Replying to ${replyFrom}'s file: ${reply.document.file_name ?? "unknown"}]`;
    } else {
      replyContext = `[Replying to ${replyFrom}'s message]`;
    }
    caption = caption ? `${replyContext}\n\n${caption}` : replyContext;
  }

  console.log(`[DOC] ${ctx.from?.first_name}: ${fileName} (${mimeType}) caption="${caption.slice(0, 60)}"`);

  enqueue(chatId, msgId, `file: ${fileName.slice(0, 40)}`, async () => {
    await ctx.replyWithChatAction("typing").catch(() => {});
    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {});
    }, 4000);

    const tracker = new ProgressTracker(ctx);
    tracker.start();

    try {
      const file = await ctx.api.getFile(doc.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
      fs.mkdirSync(TMP_DIR, { recursive: true });
      const localPath = join(TMP_DIR, `${msgId}-${fileName}`);

      const resp = await fetch(fileUrl);
      const buf = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(localPath, buf);

      const message = [
        `[File received]`,
        `Filename: ${fileName}`,
        `MIME type: ${mimeType}`,
        `Size: ${buf.length} bytes`,
        caption ? `Caption: "${caption}"` : "(no caption)",
        `Saved to: ${localPath}`,
        ``,
        `The file is available at ${localPath} — read or process it as appropriate.`,
      ].join("\n");

      const result = await spawnClaude(
        {
          sessionId: channel.sessionId,
          sessionExists: channel.sessionExists,
          settingsPath: channel.settingsPath,
          cwd: channel.cwd,
          message,
          timeoutMs: 900_000,
          onOutput: (full) => tracker.onOutput(full),
          onEvent: (evt) => tracker.onEvent(evt),
        },
        (child) => setActiveProcess(chatId, child)
      );

      clearInterval(typingInterval);

      if (!channel.sessionExists && result.ok) {
        markSessionCreated(chatId);
      }

      if (result.text) {
        const handled = await tracker.finalize(result.text);
        if (!handled) {
          await sendReply(ctx, result.text);
        } else if (result.text.length > 4000) {
          await sendReply(ctx, result.text.slice(4000));
        }
      } else {
        await tracker.cleanup();
        if (result.exitCode !== 0 && result.exitCode !== 143 && result.exitCode !== 137) {
          console.error(`[ERROR] exit=${result.exitCode}, stderr=${result.stderr.slice(0, 200)}`);
          await ctx.reply("Hit an error processing the file.");
        }
      }

      console.log(`[SPAWN] doc ${fileName} | ${result.elapsedMs}ms | exit=${result.exitCode}`);
    } catch (err) {
      clearInterval(typingInterval);
      await tracker.cleanup();
      console.error("[ERROR] doc handler:", err);
      await ctx.reply("Something went wrong with the file.");
    }
  });
});

// --- Progress tracker (single-message live streaming) ---
// One message, text grows in real-time via throttled edits (~1s).
// Tool line at top during work, drops on finalize = done signal.

import type { StreamEvent } from "./spawn";

class ProgressTracker {
  private ctx: Context;
  private msgId: number | null = null;
  private lastSentText: string = "";
  private responseText: string = "";
  private currentTool: string = "";
  private startTime: number = Date.now();
  private lastEditTime: number = 0;
  private lastTextChangeTime: number = Date.now();
  private finalized: boolean = false;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  /** Call from onOutput — receives accumulated response text */
  onOutput(fullText: string) {
    if (fullText !== this.responseText) {
      this.responseText = fullText;
      this.lastTextChangeTime = Date.now();
      this.throttledEdit();
    }
  }

  /** Call from onEvent — receives streaming events */
  onEvent(event: StreamEvent) {
    if (this.finalized) return;
    if (event.type === "tool_start" && event.toolName) {
      this.currentTool = event.toolName;
      this.throttledEdit();
    } else if (event.type === "text") {
      // text accumulation handled by onOutput
    }
  }

  /** Start — initial message after 3s if no text yet, stale check every 10s */
  start() {
    this.startTime = Date.now();
    this.initialTimer = setTimeout(() => {
      if (!this.msgId && !this.finalized) {
        this.editMessage();
      }
    }, 3_000);
    // Early finalize if text stops changing for 30s
    this.staleTimer = setInterval(() => {
      if (this.finalized) return;
      if (this.responseText.length > 100) {
        const staleMs = Date.now() - this.lastTextChangeTime;
        if (staleMs > 30_000) {
          this.finalize(this.responseText);
        }
      }
    }, 10_000);
  }

  stop() {
    if (this.initialTimer) { clearTimeout(this.initialTimer); this.initialTimer = null; }
    if (this.staleTimer) { clearInterval(this.staleTimer); this.staleTimer = null; }
  }

  /** Edit progress message into final response (tool line dropped = done signal) */
  async finalize(text?: string): Promise<boolean> {
    if (this.finalized && this.msgId === null) return false;
    this.finalized = true;
    this.stop();

    const msgId = this.msgId;
    if (msgId === null) return false;

    if (text && text.trim()) {
      try {
        await this.ctx.api.editMessageText(
          this.ctx.chat!.id, msgId,
          text.slice(0, 4000),
          { parse_mode: "Markdown" }
        );
        this.msgId = null;
        return true;
      } catch {
        try {
          await this.ctx.api.editMessageText(
            this.ctx.chat!.id, msgId,
            text.slice(0, 4000)
          );
          this.msgId = null;
          return true;
        } catch {}
      }
    }

    try { await this.ctx.api.deleteMessage(this.ctx.chat!.id, msgId); } catch {}
    this.msgId = null;
    return false;
  }

  async cleanup() {
    this.stop();
    if (this.msgId) {
      try { await this.ctx.api.deleteMessage(this.ctx.chat!.id, this.msgId); } catch {}
      this.msgId = null;
    }
  }

  /** Throttled edit — max once per second */
  private throttledEdit() {
    if (this.finalized) return;
    const now = Date.now();
    if (now - this.lastEditTime < 1_000) return;
    this.editMessage();
  }

  private async editMessage() {
    if (this.finalized) return;

    let text = "";

    if (this.currentTool) {
      text += `🔧 ${this.currentTool}\n`;
    }

    if (this.responseText.length > 0) {
      const preview = this.responseText.slice(-3800);
      text += preview;
    } else {
      const elapsed = Math.round((Date.now() - this.startTime) / 1000);
      text += `⏳ Working (${elapsed}s)...`;
    }

    if (text === this.lastSentText) return;

    try {
      if (!this.msgId) {
        const msg = await this.ctx.reply(text);
        this.msgId = msg.message_id;
      } else {
        await this.ctx.api.editMessageText(this.ctx.chat!.id, this.msgId, text);
      }
      this.lastSentText = text;
      this.lastEditTime = Date.now();
    } catch {}
  }
}

// --- Reply helper (handles message splitting + markdown fallback) ---

async function sendReply(ctx: Context, text: string): Promise<void> {
  const chunks = splitMessage(text, 4000);
  for (const chunk of chunks) {
    await ctx.reply(chunk, { parse_mode: "Markdown" }).catch(async () => {
      await ctx.reply(chunk);
    });
  }
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen * 0.5) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}

// --- Start ---

console.log(`[${BOT_NAME}] Bot starting...`);
console.log(`[${BOT_NAME}] Project root: ${PROJECT_ROOT}`);

bot.start({
  onStart: (info) => {
    console.log(`[${BOT_NAME}] Online as @${info.username} (${info.id})`);
    console.log(`[${BOT_NAME}] Waiting for messages...`);
  },
});

process.on("SIGINT", () => {
  console.log(`[${BOT_NAME}] Shutting down...`);
  bot.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log(`[${BOT_NAME}] Shutting down...`);
  bot.stop();
  process.exit(0);
});
