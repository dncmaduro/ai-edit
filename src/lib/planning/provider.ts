import "server-only";

import { GoogleGenAI } from "@google/genai";
import { STORY_PLANNER_GENERATION_CONFIG } from "@/lib/planning/config";
import { storyPlanDraftSchema, type PlannerCandidate, type StoryPlanDraft } from "@/lib/planning/schema";
import type { StoryTemplate } from "@/lib/planning/template";

export interface StoryPlanningInput { template: StoryTemplate; creativeBrief: string; candidates: PlannerCandidate[]; correction?: string; }
export interface StoryPlanningResult { draft: StoryPlanDraft; usage?: { inputTokens: number; outputTokens: number; totalTokens: number }; }
export interface StoryPlanningProvider { createPlan(input: StoryPlanningInput): Promise<StoryPlanningResult>; }
export class StoryPlanningProviderError extends Error { constructor(message: string) { super(message); this.name = "StoryPlanningProviderError"; } }

function toUsage(value: unknown): StoryPlanningResult["usage"] {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  return typeof usage.total_input_tokens === "number" && typeof usage.total_output_tokens === "number" && typeof usage.total_tokens === "number"
    ? { inputTokens: usage.total_input_tokens, outputTokens: usage.total_output_tokens, totalTokens: usage.total_tokens } : undefined;
}

const draftJsonSchema = {
  type: "object", additionalProperties: false, required: ["sections"], properties: {
    sections: { type: "array", items: { type: "object", additionalProperties: false, required: ["type", "status", "clips", "reason"], properties: {
      type: { type: "string", enum: ["highlight", "introduction", "product_info", "host_review", "friend_review", "ending"] },
      status: { type: "string", enum: ["planned", "omitted", "missing"] }, reason: { type: ["string", "null"] },
      clips: { type: "array", items: { type: "object", additionalProperties: false, required: ["candidateId", "reason", "priority"], properties: { candidateId: { type: "string" }, reason: { type: "string" }, priority: { type: "number", minimum: 0, maximum: 1 } } } },
    } } },
  },
} as const;

function buildPlannerPrompt(input: StoryPlanningInput): string {
  return `Plan a concise food-review story from supplied, grounded candidates only. Template order is highlight, introduction, product_info, host_review, friend_review, ending. Target about 100 seconds; candidate durations are source durations and M7 will solve exact timing. Use whole candidates only. A candidate may appear once total. Prefer diverse information: product visual, facts, taste, texture, price/value, and reactions. Do not invent footage, IDs, people, brands, or claims. Optional sections may be omitted; required sections with no suitable candidate must be missing. The creative brief influences preference only, never factual grounding.\n\nTemplate: ${JSON.stringify(input.template)}\nCreative brief: ${input.creativeBrief || "No additional brief."}\nCandidates: ${JSON.stringify(input.candidates)}${input.correction ? `\nCorrection: ${input.correction}` : ""}`;
}

export class GeminiStoryPlanningProvider implements StoryPlanningProvider {
  readonly #client: GoogleGenAI;
  readonly #model: string;
  constructor(apiKey: string, model: string) { this.#client = new GoogleGenAI({ apiKey }); this.#model = model; }
  async createPlan(input: StoryPlanningInput): Promise<StoryPlanningResult> {
    try {
      const response = await this.#client.interactions.create({ model: this.#model, generation_config: STORY_PLANNER_GENERATION_CONFIG, input: [{ type: "text", text: buildPlannerPrompt(input) }], response_format: { type: "text", mime_type: "application/json", schema: draftJsonSchema } });
      if (!response.output_text) throw new StoryPlanningProviderError("Gemini returned an empty planner response.");
      const parsed = storyPlanDraftSchema.safeParse(JSON.parse(response.output_text));
      if (!parsed.success) throw new StoryPlanningProviderError("Gemini planner response failed local schema validation.");
      return { draft: parsed.data, ...(toUsage(response.usage) ? { usage: toUsage(response.usage) } : {}) };
    } catch (error) {
      if (error instanceof StoryPlanningProviderError) throw error;
      throw new StoryPlanningProviderError("Gemini story planning request failed.");
    }
  }
}
