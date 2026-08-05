import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { type ParseError, parse, printParseErrorCode } from 'jsonc-parser';
import type { Config } from './types.ts';

/** Candidate config filenames, in resolution order. `.json` is kept so an older install keeps working. */
const CANDIDATES = ['sources.jsonc', 'sources.json'] as const;

/** Directory holding the server's own files — where a clone keeps its config, beside `server.ts`. */
function installDir(): string {
    return resolve(import.meta.dirname, '..');
}

/**
 * User-level config directory, mirroring the XDG handling `lib/state.ts` already does for state.
 * This is the only writable location when the server runs from a package cache (`npx`), where
 * nothing sits beside the code and the whole tree is replaced on every fetch.
 */
function xdgConfigDir(): string {
    const base = process.env.XDG_CONFIG_HOME || resolve(homedir(), '.config');
    return resolve(base, 'news-digest');
}

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
 * the server files, else the same names under {@link xdgConfigDir}.
 *
 * The install dir is checked first so a clone keeps behaving exactly as it always has — the
 * XDG location is a fallback for installs where nothing writable sits beside the code, not a
 * new preference. Returns `undefined` when nothing exists, which is what lets the caller name
 * every place it looked.
 */
function configPath(): string | undefined {
    if (process.env.NEWS_DIGEST_CONFIG) return process.env.NEWS_DIGEST_CONFIG;
    for (const dir of [installDir(), xdgConfigDir()]) {
        for (const name of CANDIDATES) {
            const p = resolve(dir, name);
            if (existsSync(p)) return p;
        }
    }
    return undefined;
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
    if (path === undefined) {
        // Name every place that was checked — which one you're meant to create depends on
        // whether this is a clone or a package-cache install, and the error can't tell.
        throw new Error(
            `No config found. Create ${resolve(xdgConfigDir(), CANDIDATES[0])} ` +
                `(copy sources-template.jsonc), or ${resolve(installDir(), CANDIDATES[0])} ` +
                `when running from a checkout, or point $NEWS_DIGEST_CONFIG at one.`,
        );
    }

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
