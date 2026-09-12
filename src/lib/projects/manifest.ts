import "server-only";

import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getProjectDir, getProjectManifestPath } from "@/lib/storage";

export type MediaProcessingStatus = "importing" | "processing" | "ready" | "failed";
export type TranscriptionStatus = "pending" | "processing" | "ready" | "failed" | "not_applicable";
export type SegmentationStatus = "pending" | "processing" | "ready" | "failed" | "not_applicable";
export type SemanticAnalysisStatus = "pending" | "processing" | "ready" | "partial" | "failed" | "not_applicable";

export interface TranscriptionState {
  status: TranscriptionStatus;
  path: string | null;
  model: string | null;
  error: string | null;
}

export interface SegmentationState {
  status: SegmentationStatus;
  scenesPath: string | null;
  segmentsPath: string | null;
  mode: "visual+transcript" | "visual-only" | null;
  error: string | null;
}

export interface SemanticAnalysisState {
  status: SemanticAnalysisStatus;
  path: string | null;
  provider: "gemini" | null;
  model: string | null;
  promptVersion: number | null;
  error: string | null;
}

export interface ProjectMediaEntry {
  id: string;
  originalFileName: string;
  rawPath: string;
  proxyPath: string;
  audioPath: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean;
  status: MediaProcessingStatus;
  error: string | null;
  transcription?: TranscriptionState;
  segmentation?: SegmentationState;
  semanticAnalysis?: SemanticAnalysisState;
}

export interface ProjectManifest {
  projectId: string;
  createdAt: string;
  updatedAt: string;
  media: ProjectMediaEntry[];
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

const manifestWriteQueues = new Map<string, Promise<void>>();

async function withManifestWriteLock<T>(
  projectId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = manifestWriteQueues.get(projectId) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queueTail = previous.then(() => gate);
  manifestWriteQueues.set(projectId, queueTail);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (manifestWriteQueues.get(projectId) === queueTail) {
      manifestWriteQueues.delete(projectId);
    }
  }
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isRelativeProjectPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.split(/[\\/]/).includes("..")
  );
}

function isMediaStatus(value: unknown): value is MediaProcessingStatus {
  return value === "importing" || value === "processing" || value === "ready" || value === "failed";
}

function isTranscriptionStatus(value: unknown): value is TranscriptionStatus {
  return (
    value === "pending" ||
    value === "processing" ||
    value === "ready" ||
    value === "failed" ||
    value === "not_applicable"
  );
}

function isSegmentationStatus(value: unknown): value is SegmentationStatus {
  return (
    value === "pending" ||
    value === "processing" ||
    value === "ready" ||
    value === "failed" ||
    value === "not_applicable"
  );
}

function isSemanticAnalysisStatus(value: unknown): value is SemanticAnalysisStatus {
  return (
    value === "pending" ||
    value === "processing" ||
    value === "ready" ||
    value === "partial" ||
    value === "failed" ||
    value === "not_applicable"
  );
}

function isTranscriptionState(value: unknown): value is TranscriptionState {
  if (!value || typeof value !== "object") {
    return false;
  }

  const transcription = value as Record<string, unknown>;
  return (
    isTranscriptionStatus(transcription.status) &&
    (transcription.path === null || isRelativeProjectPath(transcription.path)) &&
    isNullableString(transcription.model) &&
    isNullableString(transcription.error)
  );
}

function isSegmentationState(value: unknown): value is SegmentationState {
  if (!value || typeof value !== "object") {
    return false;
  }

  const segmentation = value as Record<string, unknown>;
  return (
    isSegmentationStatus(segmentation.status) &&
    (segmentation.scenesPath === null || isRelativeProjectPath(segmentation.scenesPath)) &&
    (segmentation.segmentsPath === null || isRelativeProjectPath(segmentation.segmentsPath)) &&
    (segmentation.mode === null || segmentation.mode === "visual+transcript" || segmentation.mode === "visual-only") &&
    isNullableString(segmentation.error)
  );
}

function isSemanticAnalysisState(value: unknown): value is SemanticAnalysisState {
  if (!value || typeof value !== "object") {
    return false;
  }

  const semanticAnalysis = value as Record<string, unknown>;
  return (
    isSemanticAnalysisStatus(semanticAnalysis.status) &&
    (semanticAnalysis.path === null || isRelativeProjectPath(semanticAnalysis.path)) &&
    (semanticAnalysis.provider === null || semanticAnalysis.provider === "gemini") &&
    isNullableString(semanticAnalysis.model) &&
    (semanticAnalysis.promptVersion === null ||
      (typeof semanticAnalysis.promptVersion === "number" &&
        Number.isInteger(semanticAnalysis.promptVersion) &&
        semanticAnalysis.promptVersion > 0)) &&
    isNullableString(semanticAnalysis.error)
  );
}

function isProjectMediaEntry(value: unknown): value is ProjectMediaEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const media = value as Record<string, unknown>;
  return (
    typeof media.id === "string" &&
    typeof media.originalFileName === "string" &&
    isRelativeProjectPath(media.rawPath) &&
    isRelativeProjectPath(media.proxyPath) &&
    (media.audioPath === null || isRelativeProjectPath(media.audioPath)) &&
    isNullableNumber(media.durationSeconds) &&
    isNullableNumber(media.width) &&
    isNullableNumber(media.height) &&
    isNullableNumber(media.fps) &&
    isNullableString(media.videoCodec) &&
    isNullableString(media.audioCodec) &&
    typeof media.hasAudio === "boolean" &&
    isMediaStatus(media.status) &&
    isNullableString(media.error) &&
    (media.transcription === undefined || isTranscriptionState(media.transcription)) &&
    (media.segmentation === undefined || isSegmentationState(media.segmentation)) &&
    (media.semanticAnalysis === undefined || isSemanticAnalysisState(media.semanticAnalysis))
  );
}

export function assertValidProjectManifest(value: unknown): asserts value is ProjectManifest {
  if (!value || typeof value !== "object") {
    throw new ManifestError("Project manifest must contain an object.");
  }

  const manifest = value as Record<string, unknown>;
  if (
    typeof manifest.projectId !== "string" ||
    !isIsoTimestamp(manifest.createdAt) ||
    !isIsoTimestamp(manifest.updatedAt) ||
    !Array.isArray(manifest.media) ||
    !manifest.media.every(isProjectMediaEntry)
  ) {
    throw new ManifestError("Project manifest has an invalid shape.");
  }
}

export function createEmptyProjectManifest(projectId: string): ProjectManifest {
  const timestamp = new Date().toISOString();
  return { projectId, createdAt: timestamp, updatedAt: timestamp, media: [] };
}

export async function readProjectManifest(projectId: string): Promise<ProjectManifest> {
  const manifestPath = getProjectManifestPath(projectId);
  let contents: string;

  try {
    contents = await readFile(manifestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ManifestError(`Project manifest does not exist for "${projectId}".`);
    }

    throw new ManifestError(`Unable to read project manifest for "${projectId}".`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new ManifestError(`Project manifest for "${projectId}" contains invalid JSON.`);
  }

  assertValidProjectManifest(parsed);
  if (parsed.projectId !== projectId) {
    throw new ManifestError("Project manifest ID does not match its directory.");
  }

  return parsed;
}

export async function writeProjectManifest(
  projectId: string,
  manifest: ProjectManifest,
): Promise<void> {
  assertValidProjectManifest(manifest);
  if (manifest.projectId !== projectId) {
    throw new ManifestError("Project manifest ID does not match its destination.");
  }

  const manifestPath = getProjectManifestPath(projectId);
  const tempPath = path.join(getProjectDir(projectId), `.manifest-${randomUUID()}.tmp`);
  const nextManifest = { ...manifest, updatedAt: new Date().toISOString() };

  try {
    await writeFile(tempPath, `${JSON.stringify(nextManifest, null, 2)}\n`, "utf8");
    await rename(tempPath, manifestPath);
  } catch {
    throw new ManifestError(`Unable to write project manifest for "${projectId}".`);
  }
}

export async function createProjectManifestIfMissing(projectId: string): Promise<ProjectManifest> {
  try {
    return await readProjectManifest(projectId);
  } catch (error) {
    if (!(error instanceof ManifestError) || !error.message.includes("does not exist")) {
      throw error;
    }
  }

  const manifestPath = getProjectManifestPath(projectId);
  const manifest = createEmptyProjectManifest(projectId);

  try {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return manifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return readProjectManifest(projectId);
    }

    throw new ManifestError(`Unable to create project manifest for "${projectId}".`);
  }
}

export async function updateProjectMediaEntry(
  projectId: string,
  mediaId: string,
  update: (media: ProjectMediaEntry) => ProjectMediaEntry,
): Promise<ProjectManifest> {
  return withManifestWriteLock(projectId, async () => {
    const manifest = await readProjectManifest(projectId);
    const mediaIndex = manifest.media.findIndex((media) => media.id === mediaId);

    if (mediaIndex === -1) {
      throw new ManifestError(`Media "${mediaId}" does not exist in project "${projectId}".`);
    }

    const media = update(manifest.media[mediaIndex]);
    const nextManifest = {
      ...manifest,
      media: manifest.media.map((entry, index) => (index === mediaIndex ? media : entry)),
    };
    await writeProjectManifest(projectId, nextManifest);
    return { ...nextManifest, updatedAt: new Date().toISOString() };
  });
}

export async function addProjectMediaEntry(
  projectId: string,
  media: ProjectMediaEntry,
): Promise<ProjectManifest> {
  return withManifestWriteLock(projectId, async () => {
    const manifest = await readProjectManifest(projectId);
    if (manifest.media.some((entry) => entry.id === media.id)) {
      throw new ManifestError(`Media "${media.id}" already exists in project "${projectId}".`);
    }

    const nextManifest = { ...manifest, media: [...manifest.media, media] };
    await writeProjectManifest(projectId, nextManifest);
    return { ...nextManifest, updatedAt: new Date().toISOString() };
  });
}
