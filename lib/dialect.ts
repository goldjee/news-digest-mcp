// The JSON Schema dialect the tool schemas are advertised under.
//
// `tools/list` publishes each tool's `inputSchema` and `outputSchema`, and `$schema` is not part
// of the shape being described — it is a dialect declaration, a URI naming which version of the
// JSON Schema spec the document is written in. A client resolves it against the meta-schemas its
// validator has registered, and refuses to compile a schema whose dialect it does not know.
//
// The SDK gets that declaration wrong. `McpServer`'s `tools/list` handler converts our zod
// schemas via `toJsonSchemaCompat` (server/zod-json-schema-compat.js), which for zod v3 calls
// `zod-to-json-schema` — hardcoded to draft-07. There is no way to configure it: `mcp.js` passes
// only `{ strictUnions, pipeStrategy }`, and the zod v4 branch is pinned to 'draft-7' too. Still
// true as of SDK 1.30.0, so neither upgrading the SDK nor moving to zod v4 fixes it.
//
// Claude Desktop compiles `outputSchema` with an Ajv that has only the 2020-12 meta-schema, so a
// draft-07 declaration makes the compile throw and both tools are marked unusable:
//
//     Tool 'get_news' has an invalid outputSchema: JSON Schema declares an unsupported dialect
//     ("$schema": "http://json-schema.org/draft-07/schema#").
//
// That rejection happens client-side, before a `tools/call` ever reaches this process — so every
// call fails instantly and identically, and nothing on the server can recover from it downstream.
//
// Only the declaration is wrong. Nothing in lib/schema.ts serializes to a construct the two
// dialects read differently (no `definitions`/`$defs`/`$ref`, no tuple-form `items` or
// `additionalItems`), so the emitted bodies are already valid 2020-12 and only need to say so.
// That invariant is what makes the rewrite below honest rather than a lie that happens to pass,
// and it is enforced by the release workflow's smoke test — see `.github/workflows/release.yml`.

/** The dialect every current MCP client validates against. */
export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/**
 * Correct the dialect declared by every tool schema in a `tools/list` result. Any other message
 * is returned untouched.
 *
 * Applied at the transport (see server.ts), which is the one public seam after the SDK has built
 * the listing: `McpServer` registers its own `tools/list` handler internally and exposes no hook,
 * and wrapping it would mean reaching into `server.server._requestHandlers`.
 */
export function retargetToolSchemas<T>(message: T): T {
    const tools = (message as { result?: { tools?: unknown } } | null)?.result?.tools;
    if (!Array.isArray(tools)) return message;

    for (const tool of tools) {
        if (!tool || typeof tool !== 'object') continue;
        for (const key of ['inputSchema', 'outputSchema'] as const) {
            const schema = (tool as Record<string, unknown>)[key];
            if (schema && typeof schema === 'object') {
                (schema as Record<string, unknown>).$schema = JSON_SCHEMA_DIALECT;
            }
        }
    }
    return message;
}
