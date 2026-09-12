import "server-only";
import { createHash } from "node:crypto";
import { getProject } from "@/lib/projects/service";
import { updateProjectPlanningState, type PlanningState } from "@/lib/projects/manifest";
import { readProjectSemanticIndex } from "@/lib/semantic/artifacts";
import { readProjectSegmentsArtifact } from "@/lib/segmentation/artifacts";
import { getStoryPlannerConfig, MAX_DRAFT_DURATION_SECONDS, MIN_DRAFT_DURATION_SECONDS, STORY_PLANNER_PROVIDER_NAME } from "@/lib/planning/config";
import { readEditPlan, writeEditPlan, EditPlanArtifactError } from "@/lib/planning/artifacts";
import { GeminiStoryPlanningProvider, StoryPlanningProviderError, type StoryPlanningProvider } from "@/lib/planning/provider";
import { editPlanSchema, type EditPlan, type PlannerCandidate, type StoryPlanDraft } from "@/lib/planning/schema";
import { getStoryTemplate, type StorySectionType, type StoryTemplate } from "@/lib/planning/template";

export class StoryPlanningServiceError extends Error { constructor(message: string) { super(message); this.name = "StoryPlanningServiceError"; } }
export interface PlanningResult { status: PlanningState["status"]; path?: string; plannedDurationSeconds?: number; selectedClipCount?: number; omittedOptionalSections?: StorySectionType[]; usage?: EditPlan["usage"]; consistencyRetryCount?: number; consistencyFailureCount?: number; skippedFailedSemanticCount?: number; }

function defaultPlanning(): PlanningState { return { status: "pending", path: null, templateId: null, templateVersion: null, model: null, promptVersion: null, inputHash: null, error: null }; }
function candidateScore(candidate: PlannerCandidate, section: StorySectionType): number { const s = candidate.scores; return section === "highlight" ? s.highlightValue + s.visualValue : section === "product_info" ? s.informationValue + s.visualValue : section === "host_review" || section === "friend_review" ? s.reactionValue + s.overallEditorialValue : s.overallEditorialValue; }
function compatible(candidate: PlannerCandidate, section: StorySectionType): boolean { return candidate.contentType === section || candidate.candidateSections.includes(section); }
function plannerPool(candidates: PlannerCandidate[], template: StoryTemplate): PlannerCandidate[] { const ids = new Set<string>(); for (const section of template.sections) candidates.filter((candidate) => compatible(candidate, section.type)).sort((a, b) => candidateScore(b, section.type) - candidateScore(a, section.type) || a.candidateId.localeCompare(b.candidateId)).slice(0, 8).forEach((candidate) => ids.add(candidate.candidateId)); return candidates.filter((candidate) => ids.has(candidate.candidateId)); }

async function collectCandidates(projectId: string): Promise<{ candidates: PlannerCandidate[]; skippedFailedSemanticCount: number }> {
  const manifest = await getProject(projectId); const candidates: PlannerCandidate[] = []; let skipped = 0;
  for (const media of manifest.media) {
    const state = media.semanticAnalysis;
    if (!state || (state.status !== "ready" && state.status !== "partial") || !state.path || !media.segmentation?.segmentsPath) continue;
    const [index, segments] = await Promise.all([readProjectSemanticIndex(projectId, state.path, media.id), readProjectSegmentsArtifact(projectId, media.segmentation.segmentsPath, media.id)]);
    const segmentById = new Map(segments.segments.map((segment) => [segment.id, segment]));
    for (const entry of index.segments) {
      if (entry.status !== "ready" || !entry.analysis) { skipped += 1; continue; }
      const segment = segmentById.get(entry.segmentId); if (!segment) throw new StoryPlanningServiceError(`Semantic candidate "${entry.segmentId}" is missing its M4 source segment.`);
      if (Math.abs(entry.start - segment.start) > 0.001 || Math.abs(entry.end - segment.end) > 0.001) throw new StoryPlanningServiceError(`Semantic candidate "${entry.segmentId}" does not match its M4 source bounds.`);
      candidates.push({ candidateId: `${media.id}:${entry.segmentId}`, mediaId: media.id, segmentId: entry.segmentId, start: segment.start, end: segment.end, duration: segment.end - segment.start, contentType: entry.analysis.contentType, transcriptText: segment.transcript.text, speechSummary: entry.analysis.speechSummary, visualDescription: entry.analysis.visualDescription, actions: entry.analysis.actions, reaction: entry.analysis.reaction, candidateSections: entry.analysis.candidateSections, scores: entry.analysis.scores });
    }
  }
  if (!candidates.length) throw new StoryPlanningServiceError("No usable semantic candidates are available. Run M5 explicitly first.");
  return { candidates: candidates.sort((a, b) => a.candidateId.localeCompare(b.candidateId)), skippedFailedSemanticCount: skipped };
}

function validateDraft(draft: StoryPlanDraft, candidates: PlannerCandidate[], template: StoryTemplate): string | undefined {
  const byId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate])); const seen = new Set<string>();
  if (draft.sections.length !== template.sections.length || draft.sections.some((section, index) => section.type !== template.sections[index]?.type)) return "Sections must appear once in template order.";
  for (const section of draft.sections) { const definition = template.sections.find((item) => item.type === section.type)!; if (section.status === "planned" && !section.clips.length) return `${section.type} is planned without clips.`; if (section.status !== "planned" && section.clips.length) return `${section.type} has clips but is not planned.`; if (definition.required && section.status === "omitted") return `${section.type} is required and must be planned or missing.`; for (const clip of section.clips) { const candidate = byId.get(clip.candidateId); if (!candidate) return `Unknown candidate ID ${clip.candidateId}.`; if (!compatible(candidate, section.type)) return `${clip.candidateId} is not compatible with ${section.type}.`; if (seen.has(clip.candidateId)) return `${clip.candidateId} was selected more than once.`; seen.add(clip.candidateId); } }
  const duration = draft.sections.flatMap((section) => section.clips).reduce((sum, clip) => sum + byId.get(clip.candidateId)!.duration, 0); if (duration < MIN_DRAFT_DURATION_SECONDS || duration > MAX_DRAFT_DURATION_SECONDS) return `Planned duration ${duration.toFixed(2)} is outside ${MIN_DRAFT_DURATION_SECONDS}-${MAX_DRAFT_DURATION_SECONDS} seconds.`;
  return undefined;
}

function materializePlan(projectId: string, inputHash: string, brief: string, template: StoryTemplate, candidates: PlannerCandidate[], totalCandidateCount: number, skipped: number, draft: StoryPlanDraft, usage: EditPlan["usage"], model: string): EditPlan {
  const byId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const sections = draft.sections.map((section) => { const definition = template.sections.find((item) => item.type === section.type)!; const clips = section.clips.map((clip) => { const c = byId.get(clip.candidateId)!; return { candidateId: c.candidateId, mediaId: c.mediaId, segmentId: c.segmentId, sourceStart: c.start, sourceEnd: c.end, duration: c.duration, reason: clip.reason, priority: clip.priority, semanticType: c.contentType, transcriptText: c.transcriptText, speechSummary: c.speechSummary, visualDescription: c.visualDescription }; }); return { type: section.type, status: section.status, targetDurationSeconds: definition.targetDurationSeconds, durationSeconds: clips.reduce((sum, clip) => sum + clip.duration, 0), clips, reason: section.reason }; });
  const planned = sections.flatMap((section) => section.clips); const missing = template.sections.filter((definition) => sections.find((section) => section.type === definition.type)?.status === "missing" && definition.required).map((definition) => definition.type); const omitted = template.sections.filter((definition) => sections.find((section) => section.type === definition.type)?.status === "omitted" && !definition.required).map((definition) => definition.type);
  return { version: 1, projectId, template: { id: template.id, version: template.version, targetDurationSeconds: 100 }, creativeBrief: brief, provider: { name: STORY_PLANNER_PROVIDER_NAME, model }, promptVersion: 1, generatedAt: new Date().toISOString(), source: { inputHash, candidateCount: totalCandidateCount, skippedFailedSemanticCount: skipped }, ...(usage ? { usage } : {}), sections, summary: { plannedDurationSeconds: planned.reduce((sum, clip) => sum + clip.duration, 0), usedCandidateCount: planned.length, unusedCandidateCount: totalCandidateCount - planned.length, missingRequiredSections: missing, omittedOptionalSections: omitted } };
}

function toResult(state: PlanningState, plan?: EditPlan): PlanningResult { return { status: state.status, ...(state.path ? { path: state.path } : {}), ...(plan ? { plannedDurationSeconds: plan.summary.plannedDurationSeconds, selectedClipCount: plan.summary.usedCandidateCount, omittedOptionalSections: plan.summary.omittedOptionalSections, ...(plan.usage ? { usage: plan.usage } : {}), skippedFailedSemanticCount: plan.source.skippedFailedSemanticCount } : {}) }; }

export async function createProjectEditPlan(projectId: string, templateId: string, creativeBrief: string): Promise<PlanningResult> {
  const template = getStoryTemplate(templateId); if (!template) throw new StoryPlanningServiceError("Unsupported story template."); const brief = creativeBrief.trim(); const { candidates, skippedFailedSemanticCount } = await collectCandidates(projectId); const pool = plannerPool(candidates, template); const config = getStoryPlannerConfig(); if (!config.apiKey) throw new StoryPlanningServiceError("Gemini API key is not configured."); const inputHash = createHash("sha256").update(JSON.stringify({ template, brief, candidates })).digest("hex"); const manifest = await getProject(projectId); const prior = manifest.planning ?? defaultPlanning();
  if (prior.status === "ready" && prior.path && prior.inputHash === inputHash && prior.model === config.model && prior.promptVersion === config.promptVersion) { try { return toResult(prior, await readEditPlan(projectId, prior.path)); } catch { /* regenerate a missing/corrupt artifact */ } }
  await updateProjectPlanningState(projectId, () => ({ status: "processing", path: null, templateId: template.id, templateVersion: template.version, model: config.model, promptVersion: config.promptVersion, inputHash, error: null }));
  const provider: StoryPlanningProvider = new GeminiStoryPlanningProvider(config.apiKey, config.model);
  let correction: string | undefined;
  try { for (let attempt = 0; attempt <= 1; attempt += 1) { const result = await provider.createPlan({ template, creativeBrief: brief, candidates: pool, correction }); const problem = validateDraft(result.draft, pool, template); if (!problem) { const plan = materializePlan(projectId, inputHash, brief, template, pool, candidates.length, skippedFailedSemanticCount, result.draft, result.usage, config.model); if (!editPlanSchema.safeParse(plan).success) throw new StoryPlanningServiceError("Locally materialized edit plan is invalid."); const path = await writeEditPlan(projectId, plan); const state: PlanningState = { status: "ready", path, templateId: template.id, templateVersion: template.version, model: config.model, promptVersion: config.promptVersion, inputHash, error: null }; await updateProjectPlanningState(projectId, () => state); return { ...toResult(state, plan), consistencyRetryCount: attempt, consistencyFailureCount: 0 }; } if (attempt === 1) throw new StoryPlanningServiceError(`Gemini plan remained invalid: ${problem}`); correction = `Your previous plan was invalid: ${problem} Return a corrected plan using only supplied candidates.`; } throw new StoryPlanningServiceError("Planner correction did not complete."); } catch (error) { const message = error instanceof Error ? error.message : "Story planning failed."; await updateProjectPlanningState(projectId, () => ({ status: "failed", path: null, templateId: template.id, templateVersion: template.version, model: config.model, promptVersion: config.promptVersion, inputHash, error: message })); throw error instanceof StoryPlanningServiceError || error instanceof StoryPlanningProviderError ? error : new StoryPlanningServiceError(message); }
}

export async function getProjectEditPlan(projectId: string): Promise<EditPlan> { const manifest = await getProject(projectId); if (!manifest.planning?.path) throw new StoryPlanningServiceError("Edit plan artifact does not exist for this project."); return readEditPlan(projectId, manifest.planning.path); }
export function isStoryPlanningError(error: unknown): error is StoryPlanningServiceError | StoryPlanningProviderError | EditPlanArtifactError { return error instanceof StoryPlanningServiceError || error instanceof StoryPlanningProviderError || error instanceof EditPlanArtifactError; }
