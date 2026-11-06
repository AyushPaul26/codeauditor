/** Byte-based estimate, not a model-specific tokenizer or an exact token limit. */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}

export interface ContextBudget {
  totalTokens: number;
  outputReserve: number;
  /** Estimated allowance for the agent/system prompt and preloaded tool schemas. */
  schemaReserve: number;
  instructionTokens: number;
  inputBudget: number;
}

/**
 * Allocate estimated snippet space after output, instruction and system/tool overhead.
 * The 1,536-token reserve allows for the roughly 500-token agent prompt and four
 * preloaded workspace tools. It is a conservative allowance, not a tokenizer
 * measurement; revise it when those prompts/schemas change. Conversation history
 * and compaction belong to the harness, so this is not a strict limit on its
 * complete serialized conversation or the model's actual token count.
 */
export function calculateContextBudget(
  totalTokens = 4096,
  instruction = "",
): ContextBudget {
  if (!Number.isFinite(totalTokens) || totalTokens < 0)
    throw new Error(
      "Context token budget must be a finite nonnegative number.",
    );
  totalTokens = Math.floor(totalTokens);
  const outputReserve = Math.min(1024, Math.ceil(totalTokens / 4));
  const schemaReserve = Math.min(1536, totalTokens - outputReserve);
  const instructionTokens = estimateTokens(instruction);
  return {
    totalTokens,
    outputReserve,
    schemaReserve,
    instructionTokens,
    inputBudget: Math.max(
      0,
      totalTokens - outputReserve - schemaReserve - instructionTokens,
    ),
  };
}
