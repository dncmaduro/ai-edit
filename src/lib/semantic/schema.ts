import "server-only";

import { z } from "zod";

export const CONTENT_TYPES = [
  "highlight",
  "introduction",
  "product_info",
  "host_review",
  "friend_review",
  "ending",
  "b_roll",
  "transition",
  "unclear",
] as const;
export const PEOPLE_ROLES = ["host", "friend", "staff", "customer", "unknown"] as const;
export const REACTION_SENTIMENTS = ["positive", "negative", "mixed", "neutral", "unclear"] as const;
export const REACTION_TRIGGERS = [
  "taste",
  "smell",
  "texture",
  "appearance",
  "price",
  "packaging",
  "other",
  "none",
] as const;
export const CANDIDATE_SECTIONS = [
  "highlight",
  "introduction",
  "product_info",
  "host_review",
  "friend_review",
  "ending",
] as const;
export const ACTIONS = [
  "show_product",
  "show_packaging",
  "open_package",
  "inspect_product",
  "smell_food",
  "explain_product",
  "taste_food",
  "eat_food",
  "pull_apart_food",
  "point_at_package",
  "speak_to_camera",
  "react",
  "conversation",
  "b_roll",
  "other",
] as const;
export const SHOT_FRAMINGS = [
  "wide",
  "medium",
  "medium_close_up",
  "close_up",
  "extreme_close_up",
  "product_close_up",
  "unknown",
] as const;

const scoreSchema = z.number().finite().min(0).max(1);

export const segmentSemanticAnalysisSchema = z
  .object({
    contentType: z.enum(CONTENT_TYPES),
    visualDescription: z.string(),
    speechSummary: z.string().nullable(),
    food: z
      .object({
        items: z.array(z.string()),
        brands: z.array(z.string()),
        visiblePackaging: z.boolean(),
      })
      .strict(),
    people: z
      .object({
        count: z.number().int().min(0).max(20),
        roles: z.array(z.enum(PEOPLE_ROLES)),
      })
      .strict(),
    actions: z.array(z.enum(ACTIONS)),
    reaction: z
      .object({
        present: z.boolean(),
        sentiment: z.enum(REACTION_SENTIMENTS),
        intensity: scoreSchema,
        description: z.string(),
        // Optional only to keep prompt-v1 artifacts readable. Prompt-v2 output requires it.
        trigger: z.enum(REACTION_TRIGGERS).optional(),
      })
      .strict(),
    shot: z
      .object({
        framing: z.enum(SHOT_FRAMINGS),
        foodVisible: z.boolean(),
        productVisible: z.boolean(),
      })
      .strict(),
    candidateSections: z.array(z.enum(CANDIDATE_SECTIONS)),
    scores: z
      .object({
        highlightValue: scoreSchema,
        informationValue: scoreSchema,
        reactionValue: scoreSchema,
        visualValue: scoreSchema,
        overallEditorialValue: scoreSchema,
      })
      .strict(),
    warnings: z.array(z.string()),
  })
  .strict();

export type SegmentSemanticAnalysis = z.infer<typeof segmentSemanticAnalysisSchema>;

export const semanticSegmentEntrySchema = z
  .object({
    segmentId: z.string().regex(/^seg_\d{4}$/),
    start: z.number().finite().nonnegative(),
    end: z.number().finite().positive(),
    status: z.enum(["ready", "failed"]),
    analysis: segmentSemanticAnalysisSchema.nullable(),
    error: z.string().nullable(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.start >= entry.end) {
      context.addIssue({ code: "custom", message: "Semantic segment start must be before end." });
    }
    if ((entry.status === "ready" && (!entry.analysis || entry.error !== null)) ||
      (entry.status === "failed" && (entry.analysis !== null || !entry.error))) {
      context.addIssue({ code: "custom", message: "Semantic segment state is inconsistent." });
    }
  });

export const semanticUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  })
  .strict();

export const semanticIndexSchema = z
  .object({
    version: z.literal(1),
    mediaId: z.string().uuid(),
    provider: z
      .object({ name: z.literal("gemini"), model: z.string().min(1) })
      .strict(),
    promptVersion: z.number().int().positive(),
    generatedAt: z.string().datetime(),
    source: z
      .object({
        segmentsPath: z.string().min(1),
        segmentsContentHash: z.string().regex(/^[a-f0-9]{64}$/),
        proxyPath: z.string().min(1),
      })
      .strict(),
    usage: semanticUsageSchema.optional(),
    segments: z.array(semanticSegmentEntrySchema),
  })
  .strict();

export type SemanticIndex = z.infer<typeof semanticIndexSchema>;
export type SemanticSegmentEntry = z.infer<typeof semanticSegmentEntrySchema>;
export type SemanticUsage = z.infer<typeof semanticUsageSchema>;

const stringArraySchema = { type: "array", items: { type: "string" } };
const scoreJsonSchema = { type: "number", minimum: 0, maximum: 1 };

/** JSON Schema limited to constructs supported by Gemini structured output. */
export const geminiSegmentSemanticJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "contentType",
    "visualDescription",
    "speechSummary",
    "food",
    "people",
    "actions",
    "reaction",
    "shot",
    "candidateSections",
    "scores",
    "warnings",
  ],
  properties: {
    contentType: { type: "string", enum: CONTENT_TYPES },
    visualDescription: { type: "string" },
    speechSummary: { type: ["string", "null"] },
    food: {
      type: "object",
      additionalProperties: false,
      required: ["items", "brands", "visiblePackaging"],
      properties: {
        items: stringArraySchema,
        brands: stringArraySchema,
        visiblePackaging: { type: "boolean" },
      },
    },
    people: {
      type: "object",
      additionalProperties: false,
      required: ["count", "roles"],
      properties: {
        count: { type: "integer", minimum: 0, maximum: 20 },
        roles: { type: "array", items: { type: "string", enum: PEOPLE_ROLES } },
      },
    },
    actions: { type: "array", items: { type: "string", enum: ACTIONS } },
    reaction: {
      type: "object",
      additionalProperties: false,
      required: ["present", "sentiment", "intensity", "description", "trigger"],
      properties: {
        present: { type: "boolean" },
        sentiment: { type: "string", enum: REACTION_SENTIMENTS },
        intensity: scoreJsonSchema,
        description: { type: "string" },
        trigger: { type: "string", enum: REACTION_TRIGGERS },
      },
    },
    shot: {
      type: "object",
      additionalProperties: false,
      required: ["framing", "foodVisible", "productVisible"],
      properties: {
        framing: { type: "string", enum: SHOT_FRAMINGS },
        foodVisible: { type: "boolean" },
        productVisible: { type: "boolean" },
      },
    },
    candidateSections: { type: "array", items: { type: "string", enum: CANDIDATE_SECTIONS } },
    scores: {
      type: "object",
      additionalProperties: false,
      required: [
        "highlightValue",
        "informationValue",
        "reactionValue",
        "visualValue",
        "overallEditorialValue",
      ],
      properties: {
        highlightValue: scoreJsonSchema,
        informationValue: scoreJsonSchema,
        reactionValue: scoreJsonSchema,
        visualValue: scoreJsonSchema,
        overallEditorialValue: scoreJsonSchema,
      },
    },
    warnings: stringArraySchema,
  },
} as const;
