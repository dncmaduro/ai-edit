import "server-only";

export const STORY_PLANNER_PROVIDER_NAME = "gemini";
export const DEFAULT_GEMINI_PLANNER_MODEL = "gemini-3.5-flash-lite";
export const STORY_PLANNER_PROMPT_VERSION = 1;
export const STORY_PLANNER_GENERATION_CONFIG = { seed: 0 } as const;
export const MIN_DRAFT_DURATION_SECONDS = 80;
export const MAX_DRAFT_DURATION_SECONDS = 125;

export function getStoryPlannerConfig() {
  return {
    apiKey: process.env.GEMINI_API_KEY?.trim() || null,
    model: process.env.GEMINI_PLANNER_MODEL?.trim() || DEFAULT_GEMINI_PLANNER_MODEL,
    promptVersion: STORY_PLANNER_PROMPT_VERSION,
  };
}
