// Persistent agent conversation history. Each conversation is one JSON file in
// the app's document directory (survives relaunch, sandboxed to the app). We use
// the filesystem rather than SecureStore because a conversation carries full
// command output and easily exceeds SecureStore's small per-value size limit.
//
// A conversation stores both the rendered chat (`lines`) and the model
// transcript (`turns`): the former so a reopened chat looks exactly as it did,
// the latter so the agent can be resumed with its full context intact.

import { Directory, File, Paths } from "expo-file-system";

import type { ChatLine, Turn } from "../agent/types.ts";
import { log } from "../log.ts";

export interface Conversation {
  id: string;
  /** Short label for the history list, derived from the first user message. */
  title: string;
  createdAt: number;
  updatedAt: number;
  lines: ChatLine[];
  turns: Turn[];
}

/** The lightweight subset shown in the history list. */
export type ConversationMeta = Pick<Conversation, "id" | "title" | "createdAt" | "updatedAt">;

// All conversation files live here: <document>/murmur/conversations/<id>.json
const dir = () => new Directory(Paths.document, "murmur", "conversations");
const fileFor = (id: string) => new File(dir(), `${id}.json`);

/** Create the conversations directory if it doesn't exist yet (idempotent). */
function ensureDir(): Directory {
  const d = dir();
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

/** A collision-resistant, time-sortable id. No uuid dependency needed. */
export function newConversationId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Derive a compact title from the first user goal. */
export function titleFromGoal(goal: string): string {
  const line = goal.trim().split("\n", 1)[0].trim();
  if (!line) return "New conversation";
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

/** Persist (create or overwrite) a conversation. Errors are logged, not thrown. */
export async function saveConversation(conv: Conversation): Promise<void> {
  try {
    ensureDir();
    const file = fileFor(conv.id);
    // create({ overwrite }) is create-or-truncate; then write the fresh content.
    file.create({ intermediates: true, overwrite: true });
    file.write(JSON.stringify(conv));
  } catch (e) {
    log("history", "save failed", conv.id, e);
  }
}

/** Load one conversation, or null if it's missing or unreadable. */
export async function loadConversation(id: string): Promise<Conversation | null> {
  try {
    const file = fileFor(id);
    if (!file.exists) return null;
    return JSON.parse(await file.text()) as Conversation;
  } catch (e) {
    log("history", "load failed", id, e);
    return null;
  }
}

/**
 * List conversation metadata, newest first. Reads every file and extracts the
 * meta fields; conversations are bounded in size (the daemon truncates command
 * output) and there are few of them, so a full scan is cheap and avoids a
 * separate index file that could drift out of sync with the on-disk truth.
 */
export async function listConversations(): Promise<ConversationMeta[]> {
  const d = dir();
  if (!d.exists) return [];
  const metas: ConversationMeta[] = [];
  for (const entry of d.list()) {
    if (!(entry instanceof File) || !entry.name.endsWith(".json")) continue;
    try {
      const c = JSON.parse(await entry.text()) as Conversation;
      metas.push({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt });
    } catch (e) {
      log("history", "skipping unreadable conversation", entry.name, e);
    }
  }
  return metas.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Delete one conversation. No-op (logged) if it can't be removed. */
export async function deleteConversation(id: string): Promise<void> {
  try {
    const file = fileFor(id);
    if (file.exists) file.delete();
  } catch (e) {
    log("history", "delete failed", id, e);
  }
}

/** Delete every saved conversation by removing the whole directory. */
export async function deleteAllConversations(): Promise<void> {
  try {
    const d = dir();
    if (d.exists) d.delete();
  } catch (e) {
    log("history", "delete-all failed", e);
  }
}
