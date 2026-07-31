// MCP server (stdio) for osaurus. osaurus launches this as `bun server.ts` on the
// HOST, so bun, node_modules, sources.jsonc and network are all present — no sandbox.
//
// Exposes two tools:
//   get_news({ lookbackHours?, includeSeen?, cursor?, maxChars? }) -> one page of fresh items
//   list_sources()                                                 -> configured sources (debugging)
//
// Both return the payload twice: as `structuredContent` (the real JSON object, validated
// by the SDK against the tool's outputSchema) and as serialized JSON in a text block, which
// the spec asks for so clients that predate structured output still work. Hosts that read
// only `content` (osaurus is one) see the text block, so that is what a host's per-call
// output cap is measured against — hence `get_news` pages. See lib/paginate.ts.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getNews, listSources } from './lib/run.ts';
import { listSourcesShape, payloadShape } from './lib/schema.ts';

const server = new McpServer({ name: 'news-digest', version: '1.0.0' });

server.registerTool(
    'get_news',
    {
        title: 'Get news',
        description:
            'Returns fresh news from the configured sources (Telegram t.me/s/, RSS/Atom) as ' +
            'structured JSON. By default returns only what is new since the last call (dedup ' +
            'across runs is handled server-side). Ads and off-topic reposts are filtered out by ' +
            'the model when it assembles the digest, not here. ' +
            'THE RESULT IS ONE PAGE OF SEVERAL. When `page.nextCursor` is not null, call this ' +
            'tool again passing that exact string as `cursor` and no other arguments, and keep ' +
            'going until a page comes back with `nextCursor: null`. Only then is the digest ' +
            'complete. `page.nextAction` spells out the next call each time.',
        inputSchema: {
            lookbackHours: z
                .number()
                .int()
                .positive()
                .optional()
                .describe('Window in hours. Overrides lookbackHours from sources.jsonc. Ignored when `cursor` is set.'),
            includeSeen: z
                .boolean()
                .optional()
                .describe(
                    'true — skip dedup against previous runs and do NOT persist state ' +
                        '(a one-off full pull for the window). Defaults to false. Ignored when `cursor` is set.',
                ),
            cursor: z
                .string()
                .optional()
                .describe(
                    'Continue a run already started. Pass `page.nextCursor` from the previous result ' +
                        'verbatim and omit every other argument: this replays a cached snapshot, so it ' +
                        'fetches nothing and returns instantly. Omit to start a fresh run.',
                ),
            maxChars: z
                .number()
                .int()
                .positive()
                .optional()
                .describe(
                    'Character budget for this page (default 80000, clamped to 4000-95000). Lower it ' +
                        'if your host truncates the result; the rest still arrives on later pages.',
                ),
        },
        outputSchema: payloadShape,
    },
    async ({ lookbackHours, includeSeen, cursor, maxChars }) => {
        const payload = await getNews({ lookbackHours, includeSeen, cursor, maxChars });
        return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
    },
);

server.registerTool(
    'list_sources',
    {
        title: 'List sources',
        description: 'Lists the configured sources from sources.jsonc (id, name, type, url, enabled).',
        inputSchema: {},
        outputSchema: listSourcesShape,
    },
    async () => {
        // Wrapped in an object rather than returned as a bare array: structuredContent must
        // be a JSON object, and the text block has to carry the identical value.
        const result = { sources: listSources() };
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
    },
);

const transport = new StdioServerTransport();
await server.connect(transport);
// stdio server stays alive on the transport; nothing else to do here.
