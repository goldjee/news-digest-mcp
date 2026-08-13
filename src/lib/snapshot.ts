// Run snapshots — what makes paging possible without re-fetching.
//
// `get_news` fetches every source once, writes the whole digest here, and returns the first
// page. Every later page is served straight out of this store: no network, no config reload,
// no dedup-state write. That matters twice over. The obvious reason is latency (a full run is
// dozens of article fetches). The load-bearing one is correctness: `runDigest` persists
// `seenIds` for everything it returned, so a second run would legitimately report the rest of
// the run as already seen and hand back nothing.
//
// Snapshots are disposable — an evicted or corrupt one is a cache miss, not an error, and the
// caller just starts a fresh run.

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Digest } from './run.ts';
import { stateDir, writeJsonAtomic } from './state.ts';

/** Snapshots older than this are pruned. Well past any plausible paging session. */
const MAX_AGE_MS = 24 * 3_600_000;

/** And no more than this many are kept, however recent. */
const MAX_RUNS = 10;

/** A `runId` can arrive as a tool argument, i.e. from a model — never trust one as a path. */
const RUN_ID = /^[0-9a-z-]{1,64}$/;

function runsDir(): string {
    return resolve(stateDir(), 'runs');
}

function runPath(runId: string): string {
    return resolve(runsDir(), `${runId}.json`);
}

/**
 * Mint a run id that sorts chronologically and still reads as a timestamp in a directory
 * listing. Lowercased and stripped of `:`/`.` so it stays inside {@link RUN_ID}, whose charset
 * is what keeps a model-supplied `runId` from being used as a path.
 */
function newRunId(generatedAt: string): string {
    const stamp = generatedAt.toLowerCase().replace(/[:.]/g, '-');
    return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Persist one whole digest run and return its id. Prunes older snapshots on the way out, so
 * the store stays bounded without a separate sweep.
 */
export function saveSnapshot(digest: Digest): string {
    const runId = newRunId(digest.generatedAt);
    writeJsonAtomic(runPath(runId), digest);
    prune();
    return runId;
}

/** Load a snapshotted run, or null if it never existed, expired, or can't be read. */
export function loadSnapshot(runId: string): Digest | null {
    if (!RUN_ID.test(runId)) return null;
    try {
        return JSON.parse(readFileSync(runPath(runId), 'utf8')) as Digest;
    } catch {
        return null;
    }
}

/**
 * The most recent run, or null if none is stored.
 *
 * This is what a bare `get_news({ page: 2 })` resolves against, so the client never has to
 * carry a run id. A paging session is a tight loop inside one turn, so "newest" is the run the
 * caller means; and even a stale one is the right answer, since its items were marked seen and
 * this store is the only place the undelivered remainder still exists.
 */
export function latestRunId(): string | null {
    const newest = snapshots()[0];
    return newest ? newest.runId : null;
}

/** Every stored snapshot, newest first. */
function snapshots(): { runId: string; path: string; mtime: number }[] {
    const dir = runsDir();
    if (!existsSync(dir)) return [];
    try {
        return readdirSync(dir)
            .filter((n) => n.endsWith('.json'))
            .map((name) => {
                const path = resolve(dir, name);
                return { runId: name.slice(0, -'.json'.length), path, mtime: statSync(path).mtimeMs };
            })
            .sort((a, b) => b.mtime - a.mtime);
    } catch {
        return [];
    }
}

/** Drop snapshots past {@link MAX_AGE_MS}, then any beyond the {@link MAX_RUNS} newest. */
function prune(): void {
    try {
        const cutoff = Date.now() - MAX_AGE_MS;
        for (const [i, f] of snapshots().entries()) {
            if (i < MAX_RUNS && f.mtime >= cutoff) continue;
            rmSync(f.path, { force: true });
        }
    } catch {
        // Housekeeping only — a race with a concurrent run must never fail the digest.
    }
}
