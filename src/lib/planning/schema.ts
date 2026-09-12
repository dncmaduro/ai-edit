import "server-only";

import { z } from "zod";
import { STORY_SECTION_TYPES, type StorySectionType } from "@/lib/planning/template";

const scoreSchema = z.number().finite().min(0).max(1);
export const plannerCandidateSchema = z.object({
  candidateId: z.string().min(1), mediaId: z.string().uuid(), segmentId: z.string().regex(/^seg_\d{4}$/),
  start: z.number().nonnegative(), end: z.number().positive(), duration: z.number().positive(),
  contentType: z.string(), transcriptText: z.string(), speechSummary: z.string().nullable(), visualDescription: z.string(),
  actions: z.array(z.string()), reaction: z.object({ present: z.boolean(), sentiment: z.string(), intensity: scoreSchema, trigger: z.string().optional() }).strict(),
  candidateSections: z.array(z.string()), scores: z.object({ highlightValue: scoreSchema, informationValue: scoreSchema, reactionValue: scoreSchema, visualValue: scoreSchema, overallEditorialValue: scoreSchema }).strict(),
}).strict().superRefine((candidate, context) => { if (candidate.start >= candidate.end) context.addIssue({ code: "custom", message: "Candidate range is invalid." }); });
export type PlannerCandidate = z.infer<typeof plannerCandidateSchema>;

const draftClipSchema = z.object({ candidateId: z.string().min(1), reason: z.string().min(1), priority: scoreSchema }).strict();
export const storyPlanDraftSchema = z.object({
  sections: z.array(z.object({ type: z.enum(STORY_SECTION_TYPES), status: z.enum(["planned", "omitted", "missing"]), clips: z.array(draftClipSchema), reason: z.string().nullable() }).strict()),
}).strict();
export type StoryPlanDraft = z.infer<typeof storyPlanDraftSchema>;

export const editPlanSchema = z.object({
  version: z.literal(1), projectId: z.string().min(1), template: z.object({ id: z.literal("food-review-100s"), version: z.literal(1), targetDurationSeconds: z.literal(100) }).strict(),
  creativeBrief: z.string(), provider: z.object({ name: z.literal("gemini"), model: z.string().min(1) }).strict(), promptVersion: z.literal(1), generatedAt: z.string().datetime(),
  source: z.object({ inputHash: z.string().regex(/^[a-f0-9]{64}$/), candidateCount: z.number().int().nonnegative(), skippedFailedSemanticCount: z.number().int().nonnegative() }).strict(),
  usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), totalTokens: z.number().int().nonnegative() }).strict().optional(),
  sections: z.array(z.object({ type: z.enum(STORY_SECTION_TYPES), status: z.enum(["planned", "omitted", "missing"]), targetDurationSeconds: z.number().positive(), durationSeconds: z.number().nonnegative(), clips: z.array(z.object({ candidateId: z.string(), mediaId: z.string().uuid(), segmentId: z.string().regex(/^seg_\d{4}$/), sourceStart: z.number().nonnegative(), sourceEnd: z.number().positive(), duration: z.number().positive(), reason: z.string().min(1), priority: scoreSchema, semanticType: z.string(), transcriptText: z.string(), speechSummary: z.string().nullable(), visualDescription: z.string() }).strict()), reason: z.string().nullable() }).strict()),
  summary: z.object({ plannedDurationSeconds: z.number().nonnegative(), usedCandidateCount: z.number().int().nonnegative(), unusedCandidateCount: z.number().int().nonnegative(), missingRequiredSections: z.array(z.enum(STORY_SECTION_TYPES)), omittedOptionalSections: z.array(z.enum(STORY_SECTION_TYPES)) }).strict(),
}).strict();
export type EditPlan = z.infer<typeof editPlanSchema>;
export type StoryPlanSectionType = StorySectionType;
