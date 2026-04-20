/**
 * spawn.ts — Production wrapper for `claude -p` spawns.
 *
 * - Per-spawn fluidity via --resume --session-id (create-once, resume-forever)
 * - --settings for per-channel hook/tool flavors
 * - CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 for credential safety
 */

import { spawn as nodeSpawn } from "child_process";
import { existsSync } from "fs";

export interface StreamEvent {
  type: "tool_start" | "text" | "done";
  toolName?: string;
  textChunk?: string;
}

export interface SpawnOptions {
  sessionId: string;
  sessionExists: boolean;
  settingsPath: string;
  message: string;
  appendSystemPrompt?: string;
  maxBudgetUsd?: number;
  maxTurns?: number;
  cwd?: string;
  timeoutMs?: number;
  onOutput?: (fullText: string) => void;
  onEvent?: (event: StreamEvent) => void;
}

export interface SpawnResult {
  text: string;
  sessionId: string;
  elapsedMs: number;
  ok: boolean;
  exitCode: number;
  /** Termination signal if the process was killed; null otherwise */
  signal: NodeJS.Signals | null;
  /** True when queue.stopActive tagged this child before killing — i.e. user-initiated /stop */
  interruptedByUser: boolean;
  stderr: string;
}

const PROJECT_ROOT = new URL("../", import.meta.url).pathname.replace(
  /\/$/,
  ""
);

const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-4-7";

export type OnChildSpawned = (child: import("child_process").ChildProcess) => void;

export async function spawnClaude(
  opts: SpawnOptions,
  onChildSpawned?: OnChildSpawned
): Promise<SpawnResult> {
  const start = Date.now();

  const args: string[] = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model", CLAUDE_MODEL,
    "--dangerously-skip-permissions",
  ];

  // --settings is optional — only pass it if the file exists.
  if (opts.settingsPath && existsSync(opts.settingsPath)) {
    args.push("--settings", opts.settingsPath);
  }

  if (opts.sessionExists) {
    args.push("--resume", opts.sessionId);
  } else {
    args.push("--session-id", opts.sessionId);
  }

  if (opts.appendSystemPrompt) {
    args.push("--append-system-prompt", opts.appendSystemPrompt);
  }

  if (opts.maxBudgetUsd !== undefined) {
    args.push("--max-budget-usd", opts.maxBudgetUsd.toString());
  }

  if (opts.maxTurns !== undefined) {
    args.push("--max-turns", opts.maxTurns.toString());
  }

  args.push(opts.message);

  return new Promise((resolve) => {
    const cwd = opts.cwd ?? PROJECT_ROOT;
    const timeout = opts.timeoutMs ?? 120_000;

    const child = nodeSpawn("claude", args, {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
      },
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (onChildSpawned) onChildSpawned(child);

    let rawBuf = "";
    let responseText = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      rawBuf += chunk.toString();
      const lines = rawBuf.split("\n");
      rawBuf = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const envelope = JSON.parse(line);

          if (envelope.type === "stream_event") {
            const evt = envelope.event;
            if (evt.type === "content_block_start" && evt.content_block?.type === "tool_use") {
              if (opts.onEvent) opts.onEvent({ type: "tool_start", toolName: evt.content_block.name });
            } else if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
              responseText += evt.delta.text;
              if (opts.onOutput) opts.onOutput(responseText);
              if (opts.onEvent) opts.onEvent({ type: "text", textChunk: evt.delta.text });
            } else if (evt.type === "message_stop") {
              if (opts.onEvent) opts.onEvent({ type: "done" });
            }
          }

          if (envelope.type === "result" && envelope.result) {
            responseText = envelope.result;
          }
        } catch {}
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code, signal) => {
      const elapsed = Date.now() - start;
      const interruptedByUser = Boolean(
        (child as import("child_process").ChildProcess & { __userStopped?: boolean }).__userStopped
      );
      resolve({
        text: responseText.trim(),
        sessionId: opts.sessionId,
        elapsedMs: elapsed,
        ok: code === 0,
        exitCode: code ?? 1,
        signal: signal ?? null,
        interruptedByUser,
        stderr: stderr.trim(),
      });
    });

    child.on("error", (err) => {
      const elapsed = Date.now() - start;
      resolve({
        text: "",
        sessionId: opts.sessionId,
        elapsedMs: elapsed,
        ok: false,
        exitCode: 1,
        signal: null,
        interruptedByUser: false,
        stderr: err.message,
      });
    });
  });
}
