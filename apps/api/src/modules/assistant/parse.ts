import {
  ASSISTANT_LIMITS,
  assistantModelBlockSchema,
  cleanAssistantText,
  type AssistantModelBlock,
} from '@wayora/contracts';

/*
 * Turns raw provider output into validated blocks (docs/assistant.md#validation).
 *
 * - The output must contain one JSON object with a `blocks` array. Models
 *   sometimes wrap it in a code fence or a sentence: the first balanced
 *   {...} is taken. Output with no JSON at all is accepted as ONE plain-text
 *   block (cleaned and bounded) — a useful answer without structure.
 * - Each block is validated on its own against the contract. Invalid blocks
 *   (unknown type, wrong field, bad date/time/category/currency, too long…)
 *   are dropped and counted, never "repaired".
 * - If nothing valid remains, the reply is refused (`InvalidOutput`), stored
 *   nowhere, and the user sees a retryable error.
 */

export class InvalidOutput extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOutput';
  }
}

export interface ParsedReply {
  blocks: AssistantModelBlock[];
  /** Blocks that failed validation and were dropped. */
  dropped: number;
}

/** The first balanced top-level {...} in `text`, honouring JSON strings. */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function parseModelReply(raw: string): ParsedReply {
  const json = firstJsonObject(raw);
  if (json === null) {
    const text = cleanAssistantText(raw, ASSISTANT_LIMITS.maxTextChars);
    if (!text || /[{}]/.test(text)) throw new InvalidOutput('no JSON object and no usable text');
    return { blocks: [{ type: 'text', text }], dropped: 0 };
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new InvalidOutput('malformed JSON');
  }
  const list =
    value && typeof value === 'object' && Array.isArray((value as { blocks?: unknown }).blocks)
      ? ((value as { blocks: unknown[] }).blocks as unknown[])
      : null;
  if (!list) throw new InvalidOutput('no "blocks" array');
  const blocks: AssistantModelBlock[] = [];
  let dropped = 0;
  for (const candidate of list.slice(0, ASSISTANT_LIMITS.maxBlocks * 2)) {
    const result = assistantModelBlockSchema.safeParse(candidate);
    if (result.success && blocks.length < ASSISTANT_LIMITS.maxBlocks) blocks.push(result.data);
    else dropped += 1;
  }
  dropped += Math.max(0, list.length - ASSISTANT_LIMITS.maxBlocks * 2);
  if (blocks.length === 0) throw new InvalidOutput(`no valid block (${dropped} dropped)`);
  return { blocks, dropped };
}
