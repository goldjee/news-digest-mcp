// MCP server (stdio) for osaurus. osaurus launches this as `bun server.ts` on the
// HOST, so bun, node_modules, sources.json and network are all present — no sandbox.
//
// Exposes two tools:
//   get_news({ lookbackHours?, includeSeen? }) -> structured JSON of fresh items
//   list_sources()                             -> configured sources (for debugging)

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { listSources, runDigest } from './lib/run.ts';

const server = new McpServer({ name: 'news-digest', version: '1.0.0' });

server.registerTool(
    'get_news',
    {
        title: 'Get news',
        description:
            'Возвращает свежие новости из настроенных источников (Telegram t.me/s/, RSS/Atom) ' +
            'в структурированном JSON. По умолчанию отдаёт только новое с прошлого вызова ' +
            '(дедуп между запусками — на стороне сервера). Реклама/репосты не по теме ' +
            'фильтруются моделью на этапе сборки сводки, не здесь.',
        inputSchema: {
            lookbackHours: z
                .number()
                .int()
                .positive()
                .optional()
                .describe('Окно в часах. Переопределяет lookbackHours из sources.json.'),
            includeSeen: z
                .boolean()
                .optional()
                .describe(
                    'true — не применять дедуп по прошлым запускам и НЕ сохранять состояние ' +
                        '(разовый полный сбор за окно). По умолчанию false.',
                ),
        },
    },
    async ({ lookbackHours, includeSeen }) => {
        const payload = await runDigest({ lookbackHours, includeSeen });
        return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    },
);

server.registerTool(
    'list_sources',
    {
        title: 'List sources',
        description: 'Показывает настроенные источники из sources.json (id, name, type, url, enabled).',
        inputSchema: {},
    },
    async () => ({
        content: [{ type: 'text', text: JSON.stringify(listSources(), null, 2) }],
    }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
// stdio server stays alive on the transport; nothing else to do here.
