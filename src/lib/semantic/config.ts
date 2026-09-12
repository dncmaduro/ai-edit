import "server-only";

export const SEMANTIC_PROVIDER_NAME = "gemini";
export const DEFAULT_GEMINI_ANALYSIS_MODEL = "gemini-3.5-flash-lite";
export const DEFAULT_GEMINI_ANALYSIS_CONCURRENCY = 3;
export const SEMANTIC_PROMPT_VERSION = 3;
export const MAX_TRANSIENT_RETRIES = 2;

/**
 * The installed Interactions API type does not expose temperature. A fixed
 * seed is the supported reproducibility control for structured classification.
 */
export const SEMANTIC_INTERACTION_GENERATION_CONFIG = { seed: 0 } as const;

export interface SemanticAnalysisConfig {
  provider: typeof SEMANTIC_PROVIDER_NAME;
  apiKey: string | null;
  model: string;
  concurrency: number;
  promptVersion: typeof SEMANTIC_PROMPT_VERSION;
}

function getPositiveIntegerEnvironmentValue(name: "GEMINI_ANALYSIS_CONCURRENCY", fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 8 ? parsed : fallback;
}

export function getSemanticAnalysisConfig(): SemanticAnalysisConfig {
  return {
    provider: SEMANTIC_PROVIDER_NAME,
    apiKey: process.env.GEMINI_API_KEY?.trim() || null,
    model: process.env.GEMINI_ANALYSIS_MODEL?.trim() || DEFAULT_GEMINI_ANALYSIS_MODEL,
    concurrency: getPositiveIntegerEnvironmentValue(
      "GEMINI_ANALYSIS_CONCURRENCY",
      DEFAULT_GEMINI_ANALYSIS_CONCURRENCY,
    ),
    promptVersion: SEMANTIC_PROMPT_VERSION,
  };
}

export function getSemanticAnalysisRuntimeStatus() {
  const config = getSemanticAnalysisConfig();
  return {
    provider: config.provider,
    configured: config.apiKey !== null,
    model: config.model,
  };
}
