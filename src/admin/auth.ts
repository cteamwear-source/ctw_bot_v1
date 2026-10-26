/**
 * Admin gate (ADMIN_CHAT_IDS). Kept free of heavy imports so the webhook
 * hot path can check it statically; admin handlers are lazy-loaded.
 */

import { getEnv } from "../config/env.js";

/** Normalize phone number or chat ID by stripping 'wa:', '+', and leading spaces */
export function normalizeAdminChatId(chatId: string | undefined): string {
  if (!chatId) return "";
  let id = chatId.trim();
  if (id.startsWith("wa:")) id = id.slice(3);
  if (id.startsWith("+")) id = id.slice(1);
  return id;
}

export function isAuthorizedAdmin(chatId: string | undefined): boolean {
  if (chatId === undefined) return false;
  const normalizedIncoming = normalizeAdminChatId(chatId);
  const configured = getEnv().ADMIN_CHAT_IDS.map(normalizeAdminChatId);
  return configured.includes(normalizedIncoming);
}
