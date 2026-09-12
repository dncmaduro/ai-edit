import "server-only";

import { createHash } from "node:crypto";
import type { ProjectMediaEntry, SemanticAnalysisState } from "@/lib/projects/manifest";
import { updateProjectMediaEntry } from "@/lib/projects/manifest";
import { getProject } from "@/lib/projects/service";
import { resolveProjectRelativeFile, StorageError } from "@/lib/storage";
import {
  getSemanticIndexRelativePath,
  readProjectSemanticIndex,
  SemanticArtifactError,
  writeProjectSemanticIndex,
} from "@/lib/semantic/artifacts";
import {
  getSemanticAnalysisConfig,
  MAX_TRANSIENT_RETRIES,
  SEMANTIC_PROVIDER_NAME,
} from "@/lib/semantic/config";
import {
  createVideoUnderstandingProvider,
  type AnalyzeSegmentResult,
  type ProviderCallDiagnostic,
  type VideoUnderstandingProvider,
  VideoUnderstandingProviderError,
} from "@/lib/semantic/provider";
import type {
  SegmentSemanticAnalysis,
  SemanticIndex,
  SemanticSegmentEntry,
  SemanticUsage,
} from "@/lib/semantic/schema";
import {
  readProjectSegmentsArtifact,
  SegmentationArtifactError,
  type SegmentsArtifact,
} from "@/lib/segmentation/artifacts";
import { type CandidateSegment } from "@/lib/segmentation/segmenter";
import { TranscriptionRuntimeError } from "@/lib/transcription/mlx-whisper";
import { TranscriptError } from "@/lib/transcription/transcript";

export class SemanticAnalysisServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemanticAnalysisServiceError";
  }
}

export interface SemanticAnalysisResult {
  status: SemanticAnalysisState["status"];
  path?: string;
  provider?: typeof SEMANTIC_PROVIDER_NAME;
  model?: string;
  segmentCount?: number;
  successCount?: number;
  failedCount?: number;
  usage?: SemanticUsage;
  consistencyRetryCount?: number;
  consistencyFailureCount?: number;
}

export interface SemanticSegmentSmokeTestResult {
  model: string;
  promptVersion: number;
  segment: Pick<CandidateSegment, "id" | "start" | "end">;
  upload: { state: "ACTIVE" };
  interaction: ProviderCallDiagnostic;
  structuredOutputParsed: true;
  localValidationPassed: true;
  analysis: SegmentSemanticAnalysis;
  consistencyRetries: number;
  usage?: SemanticUsage;
}

function defaultSemanticAnalysisState(): SemanticAnalysisState {
  return { status: "pending", path: null, provider: null, model: null, promptVersion: null, error: null };
}

function getSemanticAnalysisState(media: ProjectMediaEntry): SemanticAnalysisState {
  return media.semanticAnalysis ?? defaultSemanticAnalysisState();
}

async function getMediaEntry(projectId: string, mediaId: string): Promise<ProjectMediaEntry> {
  const manifest = await getProject(projectId);
  const media = manifest.media.find((entry) => entry.id === mediaId);
  if (!media) {
    throw new SemanticAnalysisServiceError(`Media "${mediaId}" does not exist in project "${projectId}".`);
  }
  return media;
}

function hashSegmentsArtifact(segments: SegmentsArtifact): string {
  return createHash("sha256").update(JSON.stringify(segments)).digest("hex");
}

function aggregateUsage(results: AnalyzeSegmentResult[]): SemanticUsage | undefined {
  const withUsage = results.flatMap((result) => (result.usage ? [result.usage] : []));
  if (withUsage.length === 0) {
    return undefined;
  }
  return withUsage.reduce(
    (total, usage) => ({
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      totalTokens: total.totalTokens + usage.totalTokens,
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
}

function toResult(state: SemanticAnalysisState, index?: SemanticIndex): SemanticAnalysisResult {
  const segmentCount = index?.segments.length;
  const successCount = index?.segments.filter((segment) => segment.status === "ready").length;
  const failedCount = segmentCount === undefined || successCount === undefined ? undefined : segmentCount - successCount;
  return {
    status: state.status,
    ...(state.path ? { path: state.path } : {}),
    ...(state.provider ? { provider: state.provider } : {}),
    ...(state.model ? { model: state.model } : {}),
    ...(segmentCount !== undefined ? { segmentCount } : {}),
    ...(successCount !== undefined ? { successCount } : {}),
    ...(failedCount !== undefined ? { failedCount } : {}),
    ...(index?.usage ? { usage: index.usage } : {}),
  };
}

async function markSemanticAnalysisFailed(
  projectId: string,
  mediaId: string,
  error: unknown,
): Promise<void> {
  const config = getSemanticAnalysisConfig();
  const message = error instanceof Error ? error.message : "Semantic analysis failed.";
  try {
    await updateProjectMediaEntry(projectId, mediaId, (media) => ({
      ...media,
      semanticAnalysis: {
        status: "failed",
        path: null,
        provider: SEMANTIC_PROVIDER_NAME,
        model: config.model,
        promptVersion: config.promptVersion,
        error: message,
      },
    }));
  } catch (manifestError) {
    console.error("[semantic-analysis] failed to persist failure", {
      projectId,
      mediaId,
      error: manifestError instanceof Error ? manifestError.message : "Unknown manifest persistence error.",
    });
  }
  console.error("[semantic-analysis] failed", { projectId, mediaId, error: message });
}

function toReadyEntry(segment: CandidateSegment, result: AnalyzeSegmentResult): SemanticSegmentEntry {
  return {
    segmentId: segment.id,
    start: segment.start,
    end: segment.end,
    status: "ready",
    analysis: result.analysis,
    error: null,
  };
}

function toFailedEntry(segment: CandidateSegment, error: unknown): SemanticSegmentEntry {
  const message = error instanceof Error ? error.message : "Segment semantic analysis failed.";
  console.warn("[semantic-analysis] segment failed", {
    segmentId: segment.id,
    error: message,
    ...(error instanceof VideoUnderstandingProviderError && error.diagnostic
      ? { diagnostic: error.diagnostic }
      : {}),
  });
  return {
    segmentId: segment.id,
    start: segment.start,
    end: segment.end,
    status: "failed",
    analysis: null,
    error: message,
  };
}

/**
 * Runs one named M4 candidate through the normal upload/readiness/interaction
 * path without changing the persisted semantic index or manifest state.
 */
export async function smokeTestProjectMediaSegment(
  projectId: string,
  mediaId: string,
  segmentId: string,
): Promise<SemanticSegmentSmokeTestResult> {
  const media = await getMediaEntry(projectId, mediaId);
  if (media.status !== "ready") {
    throw new SemanticAnalysisServiceError("Media must be ready before semantic analysis.");
  }
  if (media.segmentation?.status !== "ready" || !media.segmentation.segmentsPath) {
    throw new SemanticAnalysisServiceError("Segmentation must be ready before semantic analysis.");
  }

  let segments: SegmentsArtifact;
  try {
    segments = await readProjectSegmentsArtifact(projectId, media.segmentation.segmentsPath, mediaId);
  } catch (error) {
    throw new SemanticAnalysisServiceError(
      error instanceof Error ? error.message : "Candidate segments artifact cannot be read.",
    );
  }
  const segment = segments.segments.find((candidate) => candidate.id === segmentId);
  if (!segment) {
    throw new SemanticAnalysisServiceError(`Candidate segment "${segmentId}" does not exist.`);
  }

  const config = getSemanticAnalysisConfig();
  const provider = createVideoUnderstandingProvider();
  let preparedVideo: Awaited<ReturnType<VideoUnderstandingProvider["prepareVideo"]>> | undefined;
  try {
    const proxyPath = await resolveProjectRelativeFile(projectId, media.proxyPath);
    preparedVideo = await retryTransient(() => provider.prepareVideo(proxyPath));
    const result = await retryTransient(() =>
      provider.analyzeSegment({
        video: preparedVideo!,
        start: segment.start,
        end: segment.end,
        transcriptText: segment.transcript.text,
      }),
    );
    return {
      model: config.model,
      promptVersion: config.promptVersion,
      segment: { id: segment.id, start: segment.start, end: segment.end },
      upload: { state: preparedVideo.uploadedFileState },
      interaction: result.interaction,
      structuredOutputParsed: result.structuredOutputParsed,
      localValidationPassed: result.localValidationPassed,
      analysis: result.analysis,
      consistencyRetries: result.consistencyRetries,
      ...(result.usage ? { usage: result.usage } : {}),
    };
  } finally {
    await preparedVideo?.cleanup();
  }
}

async function retryTransient<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!(error instanceof VideoUnderstandingProviderError) || !error.transient || attempt === MAX_TRANSIENT_RETRIES) {
        throw error;
      }
      const delay = 250 * 2 ** attempt + Math.floor(Math.random() * 150);
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

async function mapWithConcurrency<T, R>(
  inputs: T[],
  concurrency: number,
  operation: (input: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(inputs.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= inputs.length) {
        return;
      }
      results[index] = await operation(inputs[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, worker));
  return results;
}

async function readReusableIndex(
  projectId: string,
  mediaId: string,
  state: SemanticAnalysisState,
  segmentsContentHash: string,
): Promise<SemanticIndex | undefined> {
  const config = getSemanticAnalysisConfig();
  if (
    state.status !== "ready" ||
    !state.path ||
    state.provider !== SEMANTIC_PROVIDER_NAME ||
    state.model !== config.model ||
    state.promptVersion !== config.promptVersion
  ) {
    return undefined;
  }
  try {
    const index = await readProjectSemanticIndex(projectId, state.path, mediaId);
    return index.source.segmentsContentHash === segmentsContentHash ? index : undefined;
  } catch {
    return undefined;
  }
}

export async function analyzeProjectMedia(projectId: string, mediaId: string): Promise<SemanticAnalysisResult> {
  const media = await getMediaEntry(projectId, mediaId);
  if (media.status !== "ready") {
    throw new SemanticAnalysisServiceError("Media must be ready before semantic analysis.");
  }
  if (media.segmentation?.status !== "ready" || !media.segmentation.segmentsPath) {
    throw new SemanticAnalysisServiceError("Segmentation must be ready before semantic analysis.");
  }

  let segments: SegmentsArtifact;
  try {
    segments = await readProjectSegmentsArtifact(projectId, media.segmentation.segmentsPath, mediaId);
  } catch (error) {
    throw new SemanticAnalysisServiceError(
      error instanceof Error ? error.message : "Candidate segments artifact cannot be read.",
    );
  }

  const config = getSemanticAnalysisConfig();
  const segmentsContentHash = hashSegmentsArtifact(segments);
  const previousState = getSemanticAnalysisState(media);
  const reusable = await readReusableIndex(projectId, mediaId, previousState, segmentsContentHash);
  if (reusable) {
    return toResult(previousState, reusable);
  }

  let provider: VideoUnderstandingProvider | undefined;
  let preparedVideo: Awaited<ReturnType<VideoUnderstandingProvider["prepareVideo"]>> | undefined;
  try {
    const proxyPath = await resolveProjectRelativeFile(projectId, media.proxyPath);
    await updateProjectMediaEntry(projectId, mediaId, (entry) => ({
      ...entry,
      semanticAnalysis: {
        status: "processing",
        path: null,
        provider: SEMANTIC_PROVIDER_NAME,
        model: config.model,
        promptVersion: config.promptVersion,
        error: null,
      },
    }));

    console.info("[semantic-analysis] started", { projectId, mediaId, model: config.model });
    provider = createVideoUnderstandingProvider();
    const activeProvider = provider;
    preparedVideo = await retryTransient(() => activeProvider.prepareVideo(proxyPath));

    const outcomes = await mapWithConcurrency(segments.segments, config.concurrency, async (segment) => {
      try {
        const result = await retryTransient(() =>
          activeProvider.analyzeSegment({
            video: preparedVideo!,
            start: segment.start,
            end: segment.end,
            transcriptText: segment.transcript.text,
          }),
        );
        return { entry: toReadyEntry(segment, result), result };
      } catch (error) {
        return { entry: toFailedEntry(segment, error) };
      }
    });

    const entries = outcomes.map((outcome) => outcome.entry);
    const successfulResults = outcomes.flatMap((outcome) => (outcome.result ? [outcome.result] : []));
    const consistencyFailureCount = outcomes.filter(
      (outcome) =>
        outcome.entry.status === "failed" &&
        outcome.entry.error?.includes("Gemini semantic response remained inconsistent") === true,
    ).length;
    const consistencyRetryCount =
      successfulResults.reduce((total, result) => total + result.consistencyRetries, 0) + consistencyFailureCount;
    const successCount = successfulResults.length;
    const status: SemanticAnalysisState["status"] =
      successCount === entries.length ? "ready" : successCount > 0 ? "partial" : "failed";
    const usage = aggregateUsage(successfulResults);
    const index: SemanticIndex = {
      version: 1,
      mediaId,
      provider: { name: SEMANTIC_PROVIDER_NAME, model: config.model },
      promptVersion: config.promptVersion,
      generatedAt: new Date().toISOString(),
      source: {
        segmentsPath: media.segmentation.segmentsPath,
        segmentsContentHash,
        proxyPath: media.proxyPath,
      },
      ...(usage ? { usage } : {}),
      segments: entries,
    };
    const artifactPath = await writeProjectSemanticIndex(projectId, index);
    const readyState: SemanticAnalysisState = {
      status,
      path: artifactPath,
      provider: SEMANTIC_PROVIDER_NAME,
      model: config.model,
      promptVersion: config.promptVersion,
      error: successCount === 0 ? "All candidate semantic analyses failed." : null,
    };
    await updateProjectMediaEntry(projectId, mediaId, (entry) => ({ ...entry, semanticAnalysis: readyState }));
    console.info("[semantic-analysis] completed", {
      projectId,
      mediaId,
      status,
      successCount,
      failedCount: entries.length - successCount,
      usage: index.usage,
    });
    return {
      ...toResult(readyState, index),
      consistencyRetryCount,
      consistencyFailureCount,
    };
  } catch (error) {
    await markSemanticAnalysisFailed(projectId, mediaId, error);
    throw new SemanticAnalysisServiceError(
      error instanceof Error ? error.message : "Unable to analyze media semantically.",
    );
  } finally {
    await preparedVideo?.cleanup();
  }
}

export async function getProjectMediaSemanticIndex(projectId: string, mediaId: string): Promise<SemanticIndex> {
  const media = await getMediaEntry(projectId, mediaId);
  const state = getSemanticAnalysisState(media);
  if (!state.path) {
    throw new SemanticAnalysisServiceError("Semantic index artifact does not exist for this media.");
  }

  try {
    return await readProjectSemanticIndex(projectId, state.path, mediaId);
  } catch (error) {
    throw new SemanticAnalysisServiceError(
      error instanceof Error ? error.message : "Semantic index artifact cannot be read.",
    );
  }
}

export function isSemanticAnalysisError(
  error: unknown,
): error is
  | SemanticAnalysisServiceError
  | SemanticArtifactError
  | SegmentationArtifactError
  | VideoUnderstandingProviderError
  | StorageError
  | TranscriptError
  | TranscriptionRuntimeError {
  return (
    error instanceof SemanticAnalysisServiceError ||
    error instanceof SemanticArtifactError ||
    error instanceof SegmentationArtifactError ||
    error instanceof VideoUnderstandingProviderError ||
    error instanceof StorageError ||
    error instanceof TranscriptError ||
    error instanceof TranscriptionRuntimeError
  );
}

export { getSemanticIndexRelativePath };
