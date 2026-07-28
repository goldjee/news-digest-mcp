import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type ParseError, parse, printParseErrorCode } from 'jsonc-parser';
import type { Config } from './types.ts';

/** Candidate config filenames, in resolution order. `.json` is kept so an older install keeps working. */
const CANDIDATES = ['sources.jsonc', 'sources.json'] as const;

/** Human-readable `line:col` for a byte offset, for parse-error messages. */
function lineCol(text: string, offset: number): string {
    const upto = text.slice(0, offset);
    const line = upto.split('\n').length;
    const col = offset - (upto.lastIndexOf('\n') + 1) + 1;
    return `${line}:${col}`;
}

/**
 * Resolve the config path: `$NEWS_DIGEST_CONFIG` if set (used as-is, even if missing, so a
 * typo surfaces as a clear error), else the first existing {@link CANDIDATES} entry beside
 * the repo root. Falls back to `sources.jsonc` so the "missing config" error names the
 * file you're meant to create.
 */
function configPath(): string {
    if (process.env.NEWS_DIGEST_CONFIG) return process.env.NEWS_DIGEST_CONFIG;
    const root = resolve(import.meta.dirname, '..');
    for (const name of CANDIDATES) {
        const p = resolve(root, name);
        if (existsSync(p)) return p;
    }
    return resolve(root, CANDIDATES[0]);
}

/**
 * Read and validate the config file, returning the parsed {@link Config}.
 *
 * The format is JSONC — plain JSON plus line/block comments and trailing commas — so the file
 * can document itself. Read fresh on every call (no caching), which is what makes edits take
 * effect without restarting the server. Defaults `lookbackHours` to 24.
 *
 * @throws if the file is missing, fails to parse, or lacks a `sources` array.
 */
export function loadConfig(): Config {
    const path = configPath();

    let raw: string;
    try {
        raw = readFileSync(path, 'utf8');
    } catch (e) {
        throw new Error(`Could not read config at ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }

    const errors: ParseError[] = [];
    const cfg = parse(raw, errors, { allowTrailingComma: true }) as Config | undefined;

    if (errors.length > 0) {
        // Report every error, not just the first — one stray comma often cascades.
        const detail = errors
            .map((e) => `${printParseErrorCode(e.error)} at line ${lineCol(raw, e.offset)}`)
            .join('; ');
        throw new Error(`${path} is not valid JSONC: ${detail}`);
    }
    if (cfg === undefined || cfg === null || typeof cfg !== 'object') {
        throw new Error(`${path}: expected a JSONC object at the top level`);
    }
    if (!Array.isArray(cfg.sources)) {
        throw new Error(`${path}: "sources" must be an array`);
    }

    cfg.lookbackHours ??= 24;
    return cfg;
}
