import "server-only";

import {
  type ProjectMediaEntry,
  type TranscriptionState,
  updateProjectMediaEntry,
} from "@/lib/projects/manifest";
import { getProject } from "@/lib/projects/service";
import { resolveProjectRelativeFile, StorageError } from "@/lib/storage";
import {
  getTranscriptionRuntimeConfig,
  transcribeAudio,
  TranscriptionRuntimeError,
} from "@/lib/transcription/mlx-whisper";
import {
  createProjectTranscript,
  getTranscriptRelativePath,
  readProjectTranscript,
  TranscriptError,
  writeProjectTranscript,
} from "@/lib/transcription/transcript";

export class TranscriptionServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptionServiceError";
  }
}

export interface TranscriptionResult {
  status: TranscriptionState["status"];
  path?: string;
  model?: string;
  language?: string;
  segmentCount?: number;
  durationSeconds?: number;
}

function defaultTranscriptionState(media: ProjectMediaEntry): TranscriptionState {
  return media.hasAudio
    ? { status: "pending", path: null, model: null, error: null }
    : { status: "not_applicable", path: null, model: null, error: null };
}

function getTranscriptionState(media: ProjectMediaEntry): TranscriptionState {
  return media.transcription ?? defaultTranscriptionState(media);
}

function getMediaEntry(projectId: string, mediaId: string): Promise<ProjectMediaEntry> {
  return getProject(projectId).then((manifest) => {
    const media = manifest.media.find((entry) => entry.id === mediaId);
    if (!media) {
      throw new TranscriptionServiceError(`Media "${mediaId}" does not exist in project "${projectId}".`);
    }

    return media;
  });
}

function toResult(
  state: TranscriptionState,
  transcript?: { language: string; segments: unknown[]; durationSeconds: number },
): TranscriptionResult {
  if (state.status === "not_applicable") {
    return { status: "not_applicable" };
  }

  return {
    status: state.status,
    ...(state.path ? { path: state.path } : {}),
    ...(state.model ? { model: state.model } : {}),
    ...(transcript
      ? {
          language: transcript.language,
          segmentCount: transcript.segments.length,
          durationSeconds: transcript.durationSeconds,
        }
      : {}),
  };
}

async function markTranscriptionFailed(
  projectId: string,
  mediaId: string,
  model: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : "Transcription failed.";

  try {
    await updateProjectMediaEntry(projectId, mediaId, (media) => ({
      ...media,
      transcription: { status: "failed", path: null, model, error: message },
    }));
  } catch (manifestError) {
    console.error("[transcription] failed to persist failure", { projectId, mediaId, manifestError });
  }

  console.error("[transcription] failed", { projectId, mediaId, error: message });
}

export async function transcribeProjectMedia(
  projectId: string,
  mediaId: string,
): Promise<TranscriptionResult> {
  const media = await getMediaEntry(projectId, mediaId);
  if (media.status !== "ready") {
    throw new TranscriptionServiceError("Media must be ready before transcription.");
  }

  const state = getTranscriptionState(media);
  if (!media.hasAudio) {
    if (state.status !== "not_applicable") {
      await updateProjectMediaEntry(projectId, mediaId, (entry) => ({
        ...entry,
        transcription: { status: "not_applicable", path: null, model: null, error: null },
      }));
    }

    return { status: "not_applicable" };
  }

  if (state.status === "ready" && state.path && state.model) {
    try {
      const transcript = await readProjectTranscript(projectId, state.path, mediaId);
      return toResult(state, transcript);
    } catch (error) {
      await markTranscriptionFailed(projectId, mediaId, state.model, error);
      throw new TranscriptionServiceError(
        error instanceof Error ? error.message : "Existing transcript cannot be read.",
      );
    }
  }

  if (!media.audioPath) {
    const error = new TranscriptionServiceError("Audio-enabled media is missing its audio artifact path.");
    await markTranscriptionFailed(projectId, mediaId, getTranscriptionRuntimeConfig().model, error);
    throw error;
  }

  const config = getTranscriptionRuntimeConfig();
  try {
    const audioPath = await resolveProjectRelativeFile(projectId, media.audioPath);
    await updateProjectMediaEntry(projectId, mediaId, (entry) => ({
      ...entry,
      transcription: { status: "processing", path: null, model: config.model, error: null },
    }));

    console.info("[transcription] started", { projectId, mediaId, runtime: "mlx-whisper", model: config.model });
    const runtimeTranscript = await transcribeAudio(audioPath);
    const transcript = createProjectTranscript(
      mediaId,
      config.model,
      media.durationSeconds,
      runtimeTranscript,
    );
    const transcriptPath = await writeProjectTranscript(projectId, transcript);
    const readyState: TranscriptionState = {
      status: "ready",
      path: transcriptPath,
      model: config.model,
      error: null,
    };
    await updateProjectMediaEntry(projectId, mediaId, (entry) => ({
      ...entry,
      transcription: readyState,
    }));

    console.info("[transcription] completed", {
      projectId,
      mediaId,
      durationSeconds: transcript.durationSeconds,
      segmentCount: transcript.segments.length,
    });
    return toResult(readyState, transcript);
  } catch (error) {
    await markTranscriptionFailed(projectId, mediaId, config.model, error);
    throw new TranscriptionServiceError(
      error instanceof Error ? error.message : "Unable to transcribe media.",
    );
  }
}

export async function getProjectMediaTranscript(
  projectId: string,
  mediaId: string,
) {
  const media = await getMediaEntry(projectId, mediaId);
  const state = getTranscriptionState(media);

  if (state.status === "failed") {
    throw new TranscriptionServiceError(`Transcription failed: ${state.error ?? "unknown error"}`);
  }

  if (state.status !== "ready" || !state.path) {
    throw new TranscriptionServiceError("Transcript does not exist for this media item.");
  }

  try {
    return await readProjectTranscript(projectId, state.path, mediaId);
  } catch (error) {
    throw new TranscriptionServiceError(
      error instanceof Error ? error.message : "Transcript cannot be read.",
    );
  }
}

export function isTranscriptionError(
  error: unknown,
): error is TranscriptionServiceError | TranscriptionRuntimeError | TranscriptError | StorageError {
  return (
    error instanceof TranscriptionServiceError ||
    error instanceof TranscriptionRuntimeError ||
    error instanceof TranscriptError ||
    error instanceof StorageError
  );
}

export { getTranscriptRelativePath };
