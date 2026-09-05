import "server-only";

import type { ProjectMediaEntry, SegmentationState } from "@/lib/projects/manifest";
import { updateProjectMediaEntry } from "@/lib/projects/manifest";
import { runFfprobe } from "@/lib/media/ffmpeg";
import { getProject } from "@/lib/projects/service";
import { resolveProjectRelativeFile, StorageError } from "@/lib/storage";
import {
  createSceneArtifact,
  createSegmentsArtifact,
  getScenesRelativePath,
  getSegmentsRelativePath,
  readProjectSceneArtifact,
  readProjectSegmentsArtifact,
  type SceneArtifact,
  type SegmentsArtifact,
  SegmentationArtifactError,
  writeProjectSceneArtifact,
  writeProjectSegmentsArtifact,
} from "@/lib/segmentation/artifacts";
import { detectScenes, SceneDetectionError } from "@/lib/segmentation/pyscenedetect";
import { generateCandidateSegments, type SegmentationMode } from "@/lib/segmentation/segmenter";
import { readProjectTranscript, TranscriptError } from "@/lib/transcription/transcript";

export class SegmentationServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SegmentationServiceError";
  }
}

export interface SegmentationResult {
  status: SegmentationState["status"];
  mode?: SegmentationMode;
  scenesPath?: string;
  segmentsPath?: string;
  sceneCount?: number;
  segmentCount?: number;
}

function defaultSegmentationState(): SegmentationState {
  return { status: "pending", scenesPath: null, segmentsPath: null, mode: null, error: null };
}

function getSegmentationState(media: ProjectMediaEntry): SegmentationState {
  return media.segmentation ?? defaultSegmentationState();
}

async function getMediaEntry(projectId: string, mediaId: string): Promise<ProjectMediaEntry> {
  const manifest = await getProject(projectId);
  const media = manifest.media.find((entry) => entry.id === mediaId);
  if (!media) {
    throw new SegmentationServiceError(`Media "${mediaId}" does not exist in project "${projectId}".`);
  }
  return media;
}

function toResult(
  state: SegmentationState,
  scenes?: SceneArtifact,
  segments?: SegmentsArtifact,
): SegmentationResult {
  return {
    status: state.status,
    ...(state.mode ? { mode: state.mode } : {}),
    ...(state.scenesPath ? { scenesPath: state.scenesPath } : {}),
    ...(state.segmentsPath ? { segmentsPath: state.segmentsPath } : {}),
    ...(scenes ? { sceneCount: scenes.scenes.length } : {}),
    ...(segments ? { segmentCount: segments.segments.length } : {}),
  };
}

async function markSegmentationFailed(
  projectId: string,
  mediaId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : "Segmentation failed.";
  try {
    await updateProjectMediaEntry(projectId, mediaId, (media) => ({
      ...media,
      segmentation: {
        status: "failed",
        scenesPath: null,
        segmentsPath: null,
        mode: null,
        error: message,
      },
    }));
  } catch (manifestError) {
    console.error("[segmentation] failed to persist failure", { projectId, mediaId, manifestError });
  }

  console.error("[segmentation] failed", { projectId, mediaId, error: message });
}

async function readReadyArtifacts(
  projectId: string,
  mediaId: string,
  state: SegmentationState,
): Promise<{ scenes: SceneArtifact; segments: SegmentsArtifact } | undefined> {
  if (state.status !== "ready" || !state.scenesPath || !state.segmentsPath) {
    return undefined;
  }

  try {
    const [scenes, segments] = await Promise.all([
      readProjectSceneArtifact(projectId, state.scenesPath, mediaId),
      readProjectSegmentsArtifact(projectId, state.segmentsPath, mediaId),
    ]);
    return { scenes, segments };
  } catch {
    return undefined;
  }
}

export async function segmentProjectMedia(projectId: string, mediaId: string): Promise<SegmentationResult> {
  const media = await getMediaEntry(projectId, mediaId);
  if (media.status !== "ready") {
    throw new SegmentationServiceError("Media must be ready before segmentation.");
  }

  const existingState = getSegmentationState(media);
  const existingArtifacts = await readReadyArtifacts(projectId, mediaId, existingState);
  if (existingArtifacts) {
    return toResult(existingState, existingArtifacts.scenes, existingArtifacts.segments);
  }

  try {
    const proxyPath = await resolveProjectRelativeFile(projectId, media.proxyPath);
    const proxyMetadata = await runFfprobe(proxyPath);
    const durationSeconds = media.durationSeconds ?? proxyMetadata.durationSeconds;
    if (!durationSeconds || durationSeconds <= 0) {
      throw new SegmentationServiceError("Proxy media has no usable duration for segmentation.");
    }

    let transcript;
    if (media.transcription?.status === "ready" && media.transcription.path) {
      transcript = await readProjectTranscript(projectId, media.transcription.path, mediaId);
    }
    const mode: SegmentationMode = transcript ? "visual+transcript" : "visual-only";

    await updateProjectMediaEntry(projectId, mediaId, (entry) => ({
      ...entry,
      segmentation: {
        status: "processing",
        scenesPath: null,
        segmentsPath: null,
        mode: null,
        error: null,
      },
    }));

    console.info("[segmentation] started", { projectId, mediaId, mode });
    const detectedScenes = await detectScenes(proxyPath);
    const scenes = createSceneArtifact(mediaId, durationSeconds, detectedScenes);
    const scenesPath = await writeProjectSceneArtifact(projectId, scenes);
    console.info("[segmentation] scene detection completed", {
      projectId,
      mediaId,
      sceneCount: scenes.scenes.length,
    });

    const candidateSegments = generateCandidateSegments(
      durationSeconds,
      scenes.scenes,
      transcript?.segments,
    );
    const segments = createSegmentsArtifact(mediaId, durationSeconds, mode, scenesPath, candidateSegments);
    const segmentsPath = await writeProjectSegmentsArtifact(projectId, segments);
    const readyState: SegmentationState = {
      status: "ready",
      scenesPath,
      segmentsPath,
      mode,
      error: null,
    };
    await updateProjectMediaEntry(projectId, mediaId, (entry) => ({ ...entry, segmentation: readyState }));
    console.info("[segmentation] candidate segmentation completed", {
      projectId,
      mediaId,
      segmentCount: segments.segments.length,
      mode,
    });

    return toResult(readyState, scenes, segments);
  } catch (error) {
    await markSegmentationFailed(projectId, mediaId, error);
    throw new SegmentationServiceError(
      error instanceof Error ? error.message : "Unable to segment media.",
    );
  }
}

export async function getProjectMediaScenes(projectId: string, mediaId: string): Promise<SceneArtifact> {
  const media = await getMediaEntry(projectId, mediaId);
  const state = getSegmentationState(media);
  if (state.status === "failed") {
    throw new SegmentationServiceError(`Segmentation failed: ${state.error ?? "unknown error"}`);
  }
  if (state.status !== "ready" || !state.scenesPath) {
    throw new SegmentationServiceError("Scene detection artifact does not exist for this media.");
  }

  try {
    return await readProjectSceneArtifact(projectId, state.scenesPath, mediaId);
  } catch (error) {
    throw new SegmentationServiceError(
      error instanceof Error ? error.message : "Scene detection artifact cannot be read.",
    );
  }
}

export async function getProjectMediaSegments(projectId: string, mediaId: string): Promise<SegmentsArtifact> {
  const media = await getMediaEntry(projectId, mediaId);
  const state = getSegmentationState(media);
  if (state.status === "failed") {
    throw new SegmentationServiceError(`Segmentation failed: ${state.error ?? "unknown error"}`);
  }
  if (state.status !== "ready" || !state.segmentsPath) {
    throw new SegmentationServiceError("Candidate segments artifact does not exist for this media.");
  }

  try {
    return await readProjectSegmentsArtifact(projectId, state.segmentsPath, mediaId);
  } catch (error) {
    throw new SegmentationServiceError(
      error instanceof Error ? error.message : "Candidate segments artifact cannot be read.",
    );
  }
}

export function isSegmentationError(
  error: unknown,
): error is SegmentationServiceError | SegmentationArtifactError | SceneDetectionError | StorageError | TranscriptError {
  return (
    error instanceof SegmentationServiceError ||
    error instanceof SegmentationArtifactError ||
    error instanceof SceneDetectionError ||
    error instanceof StorageError ||
    error instanceof TranscriptError
  );
}

export { getScenesRelativePath, getSegmentsRelativePath };
