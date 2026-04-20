/**
 * queue.ts — Per-channel message queue with stop/interrupt capability.
 *
 * Ensures only one claude -p spawn runs per channel at a time.
 * Prevents session lock contention, memory file race conditions,
 * and makes hook write-backs safe.
 *
 * Supports /stop: kills the active spawn mid-flight via SIGTERM.
 */

import type { ChildProcess } from "child_process";

export interface QueuedMessage {
  id: number;
  messageId: number;
  execute: () => Promise<void>;
  label: string;
  queuedAt: number;
}

interface ChannelQueue {
  pending: QueuedMessage[];
  processing: boolean;
  activeProcess: ChildProcess | null;
  activeLabel: string;
  activeStartedAt: number;
}

const queues = new Map<string, ChannelQueue>();
let nextId = 0;

function getQueue(chatId: string | number): ChannelQueue {
  const key = String(chatId);
  if (!queues.has(key)) {
    queues.set(key, {
      pending: [],
      processing: false,
      activeProcess: null,
      activeLabel: "",
      activeStartedAt: 0,
    });
  }
  return queues.get(key)!;
}

export function enqueue(
  chatId: string | number,
  messageId: number,
  label: string,
  execute: () => Promise<void>
): { position: number; queueLength: number } {
  const q = getQueue(chatId);
  const item: QueuedMessage = {
    id: nextId++,
    messageId,
    execute,
    label,
    queuedAt: Date.now(),
  };

  q.pending.push(item);
  const position = q.pending.length;

  const ts = new Date().toISOString();
  console.log(
    `[QUEUE] ${ts} | chat=${chatId} | msg=${messageId} | position=${position} | processing=${q.processing} | ${label}`
  );

  if (!q.processing) {
    processNext(String(chatId));
  }

  return { position, queueLength: q.pending.length };
}

export function setActiveProcess(
  chatId: string | number,
  proc: ChildProcess
): void {
  const q = getQueue(chatId);
  q.activeProcess = proc;
}

export function stopActive(chatId: string | number): {
  stopped: boolean;
  label: string;
  elapsedMs: number;
  queueRemaining: number;
} {
  const q = getQueue(chatId);

  if (!q.processing) {
    return { stopped: false, label: "", elapsedMs: 0, queueRemaining: q.pending.length };
  }

  const label = q.activeLabel;
  const elapsed = Date.now() - q.activeStartedAt;

  if (q.activeProcess) {
    try {
      // Tag first so spawn.ts can distinguish a user /stop from other SIGTERM
      // sources (node timeout, external kill) when the close event fires.
      (q.activeProcess as ChildProcess & { __userStopped?: boolean }).__userStopped = true;
      q.activeProcess.kill("SIGTERM");
    } catch {}
    q.activeProcess = null;
  }

  const ts = new Date().toISOString();
  console.log(
    `[STOP] ${ts} | chat=${chatId} | killed "${label}" after ${elapsed}ms | ${q.pending.length} remaining in queue`
  );

  // Don't clear `processing` or call `processNext` here. The old item.execute()
  // is still unwinding (spawn resolves after SIGTERM, handler replies, etc.);
  // its `finally` block owns the transition and will kick off the next item.
  // Starting here would break one-spawn-per-channel and clobber activeProcess
  // when the old finally nulls it mid-new-run.

  return { stopped: true, label, elapsedMs: elapsed, queueRemaining: q.pending.length };
}

export function clearQueue(chatId: string | number): number {
  const q = getQueue(chatId);
  const cleared = q.pending.length;
  q.pending = [];
  return cleared;
}

export function getQueueStatus(chatId: string | number): {
  processing: boolean;
  activeLabel: string;
  activeElapsedMs: number;
  pendingCount: number;
  pendingLabels: string[];
} {
  const q = getQueue(chatId);
  return {
    processing: q.processing,
    activeLabel: q.activeLabel,
    activeElapsedMs: q.processing ? Date.now() - q.activeStartedAt : 0,
    pendingCount: q.pending.length,
    pendingLabels: q.pending.map((p) => p.label),
  };
}

async function processNext(chatId: string): Promise<void> {
  const q = getQueue(chatId);
  if (q.processing || q.pending.length === 0) return;

  const item = q.pending.shift()!;
  q.processing = true;
  q.activeLabel = item.label;
  q.activeStartedAt = Date.now();
  q.activeProcess = null;

  const waitTime = Date.now() - item.queuedAt;
  const ts = new Date().toISOString();
  console.log(
    `[QUEUE] ${ts} | chat=${chatId} | msg=${item.messageId} | DEQUEUED after ${waitTime}ms wait | ${item.label}`
  );

  try {
    await item.execute();
  } catch (err) {
    console.error(`[QUEUE] Error processing msg=${item.messageId}:`, err);
  } finally {
    q.processing = false;
    q.activeProcess = null;
    q.activeLabel = "";
    q.activeStartedAt = 0;

    if (q.pending.length > 0) {
      processNext(chatId);
    }
  }
}
