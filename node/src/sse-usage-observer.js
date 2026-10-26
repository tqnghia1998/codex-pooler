import { extractUsage, mergeUsage } from './pricing.js';
import { consumeSseChunk, createSseParserState, decodeSseBlock, pendingSseBlock } from './openai-streaming.js';

// Keep only statistics from complete, bounded events while a collected body
// may still fail. Never estimate usage from incomplete JSON or event suffixes.
export function createSseUsageObserver() {
  const decoder = new TextDecoder();
  let parser = createSseParserState();
  let usage = null;
  const collect = (block) => {
    const decoded = decodeSseBlock(block);
    if (decoded.kind === 'event') usage = mergeUsage(usage, extractUsage(decoded.event));
  };
  return {
    get usage() { return usage; },
    write(chunk, final = false) {
      const result = consumeSseChunk(parser, decoder.decode(chunk, { stream: !final }));
      parser = result.state;
      for (const block of result.blocks) collect(block);
      if (final) collect(pendingSseBlock(parser));
    }
  };
}
