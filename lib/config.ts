import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Config } from './types.ts';

/**
 * Read and validate `sources.json`, returning the parsed {@link Config}.
 *
 * Resolved from `$NEWS_DIGEST_CONFIG`, falling back to `<repo>/sources.json`.
 * Read fresh on every call (no caching). Defaults `lookbackHours` to 24.
 *
 * @throws if the file is missing, is not valid JSON, or lacks a `sources` array.
 */
export function loadConfig(): Config {
    const path = process.env.NEWS_DIGEST_CONFIG || resolve(import.meta.dirname, '..', 'sources.json');

    let raw: string;
    try {
        raw = readFileSync(path, 'utf8');
    } catch (e) {
        throw new Error(`Could not read config at ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }

    let cfg: Config;
    try {
        cfg = JSON.parse(raw) as Config;
    } catch (e) {
        throw new Error(`sources.json is not valid JSON (${path}): ${e instanceof Error ? e.message : String(e)}`);
    }

    if (!Array.isArray(cfg.sources)) {
        throw new Error(`sources.json: "sources" must be an array (${path})`);
    }
    cfg.lookbackHours ??= 24;
    return cfg;
}
