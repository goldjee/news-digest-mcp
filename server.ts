// MCP server (stdio) for osaurus. osaurus launches this as `bun server.ts` on the
// HOST, so bun, node_modules, sources.jsonc and network are all present — no sandbox.
//
// Exposes two tools:
//   get_news({ page?, lookbackHours?, includeSeen?, maxChars?, runId? }) -> one page of fresh items
//   list_sources()                                                       -> configured sources (debugging)
//
// Both return the payload twice: as `structuredContent` (the real JSON object, validated
// by the SDK against the tool's outputSchema) and as serialized JSON in a text block, which
// the spec asks for so clients that predate structured output still work. Hosts that read
// only `content` (osaurus is one) see the text block, so that is what a host's per-call
// output cap is measured against — hence `get_news` pages. See lib/paginate.ts. The text
// block's exact shape is the `hostEnvelope` config key; see lib/envelope.ts.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { errorText, toolText } from './lib/envelope.ts';
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
            'THE RESULT IS ONE PAGE OF SEVERAL, and every result says which. While the result has ' +
            '`nextPageNeeded: true`, you do NOT have the whole digest yet: call this tool again ' +
            "with `page` set to the result's `nextPage` value and no other arguments. Repeat " +
            'until a result comes back with `nextPageNeeded: false`, and write nothing before ' +
            'then. `page.totalPages` says how many calls that will take.',
        inputSchema: {
            page: z
                .number()
                .int()
                .positive()
                .optional()
                .describe(
                    "Which page to return, counting from 1. Pass the previous result's `nextPage` " +
                        'value to continue: that reads a cached snapshot, so it fetches nothing and ' +
                        'returns instantly. Omit to start a fresh run and get page 1.',
                ),
            lookbackHours: z
                .number()
                .int()
                .positive()
                .optional()
                .describe('Window in hours. Overrides lookbackHours from sources.jsonc. Ignored when `page` is set.'),
            includeSeen: z
                .boolean()
                .optional()
                .describe(
                    'true — skip dedup against previous runs and do NOT persist state ' +
                        '(a one-off full pull for the window). Defaults to false. Ignored when `page` is set.',
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
            runId: z
                .string()
                .optional()
                .describe(
                    'Pin paging to one specific run. Not normally needed — `page` alone continues the ' +
                        'most recent run. Only useful when several runs are being paged at once.',
                ),
        },
        outputSchema: payloadShape,
    },
    async ({ page, lookbackHours, includeSeen, maxChars, runId }) => {
        try {
            const payload = await getNews({ page, lookbackHours, includeSeen, maxChars, runId });
            return { content: [{ type: 'text', text: toolText(payload, 'get_news') }], structuredContent: payload };
        } catch (err) {
            // Caught here rather than left to the SDK so the failure can carry the host's own
            // error shape — osaurus never reads `isError`, and an unshaped message reaches the
            // model labelled as a success.
            return { content: [{ type: 'text', text: errorText(err, 'get_news') }], isError: true };
        }
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
        return { content: [{ type: 'text', text: toolText(result, 'list_sources') }], structuredContent: result };
    },
);

const transport = new StdioServerTransport();
await server.connect(transport);
// stdio server stays alive on the transport; nothing else to do here.
