// Types for hooks/voice-files.mjs, so src/ can import it.
export interface InboxEntry {
  text: string;
  at: number;
}
export function cacheRoot(env?: NodeJS.ProcessEnv): string;
export function voiceModeDir(root: string): string;
export function listeningFile(dir: string): string;
export function inboxDir(dir: string): string;
export function callFile(dir: string): string;
export function muteFile(dir: string): string;
export function permissionFile(dir: string): string;
export const INBOX_MAX_AGE_MS: number;
export function readJson(file: string): unknown;
export function isAlive(pid: number): boolean;
export function takeInbox(dir: string, now?: number): InboxEntry[];
