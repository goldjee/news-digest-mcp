import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

/** Dedup bookkeeping for a single source. */
export interface SourceState {
    /** ISO timestamp of the last run that persisted this entry. */
    lastRunISO: string;
    /** Recently emitted item ids, newest first (bounded by `dedupeKeepRecent`). */
    seenIds: string[];
}

/** Full persisted state, keyed by source id. */
export type State = Record<string, SourceState>;

/**
 * State lives OUTSIDE the skill dir so it keeps working even if the skill is
 * installed read-only. Override with $NEWS_DIGEST_STATE.
 */
function statePath(): string {
    if (process.env.NEWS_DIGEST_STATE) return process.env.NEWS_DIGEST_STATE;
    const base = process.env.XDG_STATE_HOME || resolve(homedir(), '.local', 'state');
    return resolve(base, 'news-digest', 'state.json');
}

/** Load persisted state, or `{}` if the file is missing or unreadable. */
export function loadState(): State {
    try {
        return JSON.parse(readFileSync(statePath(), 'utf8')) as State;
    } catch {
        return {};
    }
}

/** Persist state to disk (write-then-rename, so a crash can't corrupt it), creating the parent directory if needed. */
export function saveState(state: State): void {
    const p = statePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(`${p}.tmp`, JSON.stringify(state, null, 2), 'utf8');
    renameSync(`${p}.tmp`, p);
}

/** Return the first `cap` unique ids, preserving order (newest first). */
export function dedupeKeepRecent(ids: string[], cap: number): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
        if (out.length >= cap) break;
    }
    return out;
}
