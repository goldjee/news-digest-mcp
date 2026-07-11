import { parse } from 'node-html-parser';

/** Convert an HTML fragment to clean plain text (entities decoded, <br>/<p> -> newlines). */
export function stripHtml(input: string | undefined | null): string {
    if (!input) return '';
    const withBreaks = String(input)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n');
    const root = parse(withBreaks);
    // .text includes the raw contents of block-text elements — drop them explicitly.
    for (const node of root.querySelectorAll('script,style,noscript')) node.remove();
    return root.text
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Clamp a string to at most `max` chars, appending an ellipsis when it's cut. */
export function truncate(s: string, max?: number): string {
    if (!max || s.length <= max) return s;
    return `${s.slice(0, max - 1).trimEnd()}…`;
}

/** Normalize a single value or array (or missing) into an array. */
export function asArray<T>(v: T | T[] | undefined | null): T[] {
    if (v == null) return [];
    return Array.isArray(v) ? v : [v];
}

/** Parse any date-ish string to ISO 8601, or null if unparseable. */
export function toISO(dateLike: string | undefined | null): string | null {
    if (!dateLike) return null;
    const t = Date.parse(String(dateLike));
    return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Hard ceiling on response bodies — feeds/previews are well under 1 MB. */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/** GET a URL as text with a browser-like UA (some sources vary output by UA). */
export async function fetchText(url: string, timeoutMs = 15_000): Promise<string> {
    try {
        const res = await fetch(url, {
            redirect: 'follow',
            signal: AbortSignal.timeout(timeoutMs),
            headers: {
                'user-agent':
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
                    '(KHTML, like Gecko) Chrome/126.0 Safari/537.36',
                'accept-language': 'en,ru;q=0.8',
                accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
        if (!res.body) return '';

        const decoder = new TextDecoder();
        let text = '';
        let bytes = 0;
        for await (const chunk of res.body) {
            bytes += chunk.byteLength;
            if (bytes > MAX_RESPONSE_BYTES) {
                throw new Error(`Response exceeds ${MAX_RESPONSE_BYTES / 1024 / 1024} MB for ${url}`);
            }
            text += decoder.decode(chunk, { stream: true });
        }
        return text + decoder.decode();
    } catch (e) {
        if (e instanceof DOMException && e.name === 'TimeoutError') {
            throw new Error(`Timeout after ${timeoutMs / 1000}s for ${url}`);
        }
        throw e;
    }
}
