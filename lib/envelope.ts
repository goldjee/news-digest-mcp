// How the `content` text block is shaped, per host.
//
// The MCP spec says a tool returning `structuredContent` SHOULD also put the serialized JSON in
// a text block, for clients that predate structured output. That is the `"none"` default here
// and it is what every spec-current client wants.
//
// osaurus needs one deviation. It ignores `structuredContent` entirely and reads only the text
// block — and then, in `ToolRegistry.normalizeToolResult`, it re-encodes anything that is not
// one of its own envelopes: `ToolEnvelope.success(tool:text:)` puts our payload in
// `result.text`, as a JSON *string*, so every `"` in 80 kB of digest becomes `\"`. That fourth
// encoding is what reaches the model, nothing unescapes it, and models imitate it — a local 12B
// reading escaped JSON starts writing escaped prose.
//
// Its own tests pin the way out (`ToolResultNormalizationTests`):
// `existingSuccessEnvelopePassesThroughUntouched`. `ToolEnvelope.isSuccess` only asks that the
// string start with `{` and contain `"ok":true`, and anything matching is returned
// byte-identical. So under `"osaurus"` we hand it a ready-made envelope and the payload arrives
// clean — and slightly *smaller*, since the wrapper costs ~45 chars and buys back a backslash
// on every quote.

import { loadConfig } from './config.ts';

/** Text-block shape. `none` = serialized payload (spec default); `osaurus` = host envelope. */
export type HostEnvelope = 'none' | 'osaurus';

function mode(): HostEnvelope {
    return loadConfig().hostEnvelope === 'osaurus' ? 'osaurus' : 'none';
}

/** Serialize a tool payload for the `content` text block. */
export function toolText(payload: unknown, toolName: string): string {
    if (mode() === 'none') return JSON.stringify(payload);
    return JSON.stringify({ ok: true, tool: toolName, result: payload });
}

/**
 * Serialize a tool failure for the `content` text block.
 *
 * osaurus's MCP path never looks at `isError`, so a plain error string is wrapped as a *success*
 * envelope and the model is told the call worked. Under `"osaurus"` we emit the failure shape
 * its `ToolEnvelope.isError` recognises instead. `retryable` is true because every error this
 * server raises is worth another attempt with different arguments — a stale page number, a
 * snapshot that has aged out, a source that timed out.
 */
export function errorText(err: unknown, toolName: string): string {
    const message = err instanceof Error ? err.message : String(err);
    if (mode() === 'none') return message;
    return JSON.stringify({ ok: false, kind: 'execution_error', message, tool: toolName, retryable: true });
}

/**
 * Characters the envelope adds to a payload of `payloadChars`, so a paging budget can stay
 * expressed in "characters the host will count". Measured rather than guessed, since the tool
 * name is part of it.
 */
export function envelopeOverhead(toolName: string): number {
    if (mode() === 'none') return 0;
    // The wrapper around an empty object, minus the `{}` that object contributes itself.
    return JSON.stringify({ ok: true, tool: toolName, result: {} }).length - 2;
}
