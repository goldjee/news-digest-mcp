import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import type { Ctx, Item } from './types.ts';
import { fetchPage, mapWithLimit, stripHtml, truncate } from './util.ts';

/** Only these are worth handing to the extractor — PDFs, images and JSON are skipped. */
const HTML_TYPE = /^\s*(?:text\/html|application\/xhtml\+xml)/i;

/** Ignore one-liners when measuring coverage — captions and credits are not prose. */
const MIN_PARAGRAPH_CHARS = 40;

/** Below this share of the page's prose, assume Readability anchored on a fragment (see `repair`). */
const MIN_COVERAGE = 0.85;

/** A repaired body has to recover at least this much more text to be worth its flatter structure. */
const MIN_REPAIR_GAIN = 1.1;

/** Page chrome that is never article prose, excluded before measuring coverage. */
const CHROME = 'aside, nav, footer, form';

/**
 * Follow each item's URL and swap in the article body extracted by Firefox's reader-mode
 * algorithm (`@mozilla/readability` over a `linkedom` DOM). It scores the DOM by text
 * density, so it is site-agnostic — no per-domain rules to maintain.
 *
 * Best-effort per item: a dead link, a paywall, a JS-only page, or a body no longer than
 * what the feed already gave us all leave the original text in place, marked
 * `textSource: 'feed'`. A source never errors because one article failed to load.
 */
export async function enrichWithArticleText(items: Item[], ctx: Ctx): Promise<Item[]> {
    const opts = ctx.config.fullText ?? {};
    const minChars = opts.minChars ?? 200;

    return mapWithLimit(items, opts.concurrency ?? 4, async (item) => {
        const text = item.url
            ? await articleText(item.url, opts.timeoutMs ?? ctx.config.fetchTimeoutMs, opts.charThreshold)
            : null;

        // A stub, teaser or consent page must not downgrade an item that already has a body.
        if (!text || text.length < minChars || text.length <= item.text.length) {
            return { ...item, textSource: 'feed' };
        }
        return { ...item, text: truncate(text, ctx.config.maxCharsPerItem), textSource: 'article' };
    });
}

/** One paragraph of page prose, captured as plain data before Readability mutates the DOM. */
interface Para {
    text: string;
    /** Wrapper fingerprint — paragraphs of the same kind share one (see `repair`). */
    sig: string;
}

/** Extract one page's article text, or null if it isn't extractable for any reason. */
async function articleText(url: string, timeoutMs?: number, charThreshold?: number): Promise<string | null> {
    try {
        const page = await fetchPage(url, timeoutMs);
        if (!HTML_TYPE.test(page.contentType)) return null;

        const { document } = parseHTML(page.html);
        // Figures are an image plus a caption — noise in a text digest, and sites that render
        // the caption as plain text (BBC's "Image caption, …") get it kept as article prose.
        for (const figure of document.querySelectorAll('figure')) figure.remove();

        // Snapshot the prose next: Readability mutates the document it parses.
        const prose = paragraphs(document);

        // linkedom's Document is its own type; Readability only touches the DOM subset it implements.
        const doc = document as unknown as ConstructorParameters<typeof Readability>[0];
        const article = new Readability(doc, { charThreshold }).parse();
        if (!article) return null;

        // stripHtml over the extracted markup keeps the paragraph breaks that
        // Readability's own flattened textContent throws away.
        const body = stripHtml(article.content);
        return repair(prose, body) ?? body;
    } catch {
        return null;
    }
}

/** Collect the page's prose paragraphs, scoped to the article container and minus obvious chrome. */
function paragraphs(document: ReturnType<typeof parseHTML>['document']): Para[] {
    const scope = document.querySelector('article, main, [role="main"]') ?? document.body;
    if (!scope) return [];

    const out: Para[] = [];
    for (const p of scope.querySelectorAll('p')) {
        const text = p.textContent?.trim() ?? '';
        if (text.length <= MIN_PARAGRAPH_CHARS || p.closest(CHROME)) continue;
        const parent = p.parentElement;
        out.push({ text, sig: `${parent?.tagName ?? ''}.${parent?.className ?? ''}` });
    }
    return out;
}

/**
 * Recover prose Readability left behind.
 *
 * On pages that split an article into a run of sibling blocks (BBC's layout, for one) it
 * can anchor on the largest block and silently drop everything above it — including the
 * lede. That reads as a complete article, so it is worse than an outright failure.
 *
 * When too little of the page's prose survived, rebuild the body from every paragraph
 * whose wrapper fingerprint matches one Readability *did* keep. That learns the page's own
 * structure instead of hardcoding selectors, so captions, promos and related-links blocks —
 * which live in different wrappers — stay out. Returns null when no repair is warranted.
 */
function repair(prose: Para[], body: string): string | null {
    if (prose.length === 0) return null;

    const normalized = normalize(body);
    const chars = (list: Para[]) => list.reduce((n, p) => n + p.text.length, 0);
    const kept = prose.filter((p) => normalized.includes(normalize(p.text).slice(0, 50)));
    if (chars(kept) >= chars(prose) * MIN_COVERAGE) return null;

    const keptSigs = new Set(kept.map((p) => p.sig));
    const rebuilt = prose
        .filter((p) => keptSigs.has(p.sig))
        .map((p) => p.text)
        .join('\n\n');

    // The rebuilt body is flat text (no headings or lists), so only take it when it
    // recovers enough prose to pay for that.
    return rebuilt.length > body.length * MIN_REPAIR_GAIN ? rebuilt : null;
}

/** Fold text down to bare words for matching, so markup and whitespace differences don't matter. */
function normalize(s: string): string {
    return s
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .toLowerCase();
}
