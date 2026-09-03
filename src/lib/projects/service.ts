import "server-only";

import { constants } from "node:fs";
import { copyFile, lstat, realpath, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  extractNormalizedAudio,
  generateProxyVideo,
  type MediaMetadata,
  runFfprobe,
} from "@/lib/media/ffmpeg";
import {
  addProjectMediaEntry,
  createProjectManifestIfMissing,
  type ProjectManifest,
  type ProjectMediaEntry,
  readProjectManifest,
  updateProjectMediaEntry,
} from "@/lib/projects/manifest";
import {
  assertSafeProjectId,
  ensureProjectDirectories,
  getProjectAudioDir,
  getProjectProxyDir,
  getProjectRawDir,
  StorageError,
} from "@/lib/storage";

export class ProjectServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectServiceError";
  }
}

export interface ProjectSummary {
  projectId: string;
  createdAt: string;
  updatedAt: string;
  mediaCount: number;
}

export interface ImportedMediaResult {
  id: string;
  originalFileName: string;
  status: ProjectMediaEntry["status"];
  metadata: MediaMetadata;
  rawPath: string;
  proxyPath: string;
  audioPath: string | null;
}

function toProjectSummary(manifest: ProjectManifest): ProjectSummary {
  return {
    projectId: manifest.projectId,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    mediaCount: manifest.media.length,
  };
}

function getSafeExtension(fileName: string): string {
  const extension = path.extname(fileName);
  return /^\.[a-zA-Z0-9]{1,16}$/.test(extension) ? extension.toLowerCase() : "";
}

async function resolveImportSourceFile(sourcePath: string): Promise<{ path: string; fileName: string }> {
  if (!path.isAbsolute(sourcePath)) {
    throw new ProjectServiceError("Source path must be an absolute path.");
  }

  let sourceInfo;
  try {
    sourceInfo = await lstat(sourcePath);
  } catch {
    throw new ProjectServiceError("Source file does not exist or cannot be accessed.");
  }

  if (sourceInfo.isSymbolicLink()) {
    throw new ProjectServiceError("Source path must not be a symbolic link.");
  }

  if (!sourceInfo.isFile()) {
    throw new ProjectServiceError("Source path must point to a regular file.");
  }

  let resolvedPath: string;
  try {
    resolvedPath = await realpath(sourcePath);
  } catch {
    throw new ProjectServiceError("Source file cannot be resolved.");
  }

  const resolvedInfo = await stat(resolvedPath);
  if (!resolvedInfo.isFile()) {
    throw new ProjectServiceError("Source path must resolve to a regular file.");
  }

  return { path: resolvedPath, fileName: path.basename(resolvedPath) };
}

function toMediaResult(media: ProjectMediaEntry): ImportedMediaResult {
  return {
    id: media.id,
    originalFileName: media.originalFileName,
    status: media.status,
    metadata: {
      durationSeconds: media.durationSeconds,
      width: media.width,
      height: media.height,
      fps: media.fps,
      videoCodec: media.videoCodec,
      audioCodec: media.audioCodec,
      hasAudio: media.hasAudio,
    },
    rawPath: media.rawPath,
    proxyPath: media.proxyPath,
    audioPath: media.audioPath,
  };
}

async function markMediaFailed(
  projectId: string,
  mediaId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : "Media processing failed.";

  try {
    await updateProjectMediaEntry(projectId, mediaId, (media) => ({
      ...media,
      status: "failed",
      error: message,
    }));
  } catch (manifestError) {
    console.error("[media] failed to persist failure", { projectId, mediaId, manifestError });
  }

  console.error("[media] failed", { projectId, mediaId, error: message });
}

export async function createProject(projectId: string): Promise<ProjectSummary> {
  assertSafeProjectId(projectId);
  await ensureProjectDirectories(projectId);
  const manifest = await createProjectManifestIfMissing(projectId);

  console.info("[project] created or loaded", { projectId, mediaCount: manifest.media.length });
  return toProjectSummary(manifest);
}

export async function getProject(projectId: string): Promise<ProjectManifest> {
  assertSafeProjectId(projectId);
  return readProjectManifest(projectId);
}

export async function importProjectMedia(
  projectId: string,
  sourcePath: string,
): Promise<ImportedMediaResult> {
  await createProject(projectId);
  const source = await resolveImportSourceFile(sourcePath);
  const mediaId = randomUUID();
  const rawFileName = `${mediaId}${getSafeExtension(source.fileName)}`;
  const proxyFileName = `${mediaId}.mp4`;
  const audioFileName = `${mediaId}.wav`;
  const rawPath = path.join(getProjectRawDir(projectId), rawFileName);
  const proxyPath = path.join(getProjectProxyDir(projectId), proxyFileName);
  const audioPath = path.join(getProjectAudioDir(projectId), audioFileName);
  const initialMedia: ProjectMediaEntry = {
    id: mediaId,
    originalFileName: source.fileName,
    rawPath: path.posix.join("raw", rawFileName),
    proxyPath: path.posix.join("proxy", proxyFileName),
    audioPath: null,
    durationSeconds: null,
    width: null,
    height: null,
    fps: null,
    videoCodec: null,
    audioCodec: null,
    hasAudio: false,
    status: "importing",
    error: null,
  };

  await addProjectMediaEntry(projectId, initialMedia);
  console.info("[media] import started", { projectId, mediaId, sourcePath: source.path });

  try {
    await copyFile(source.path, rawPath, constants.COPYFILE_EXCL);
    await updateProjectMediaEntry(projectId, mediaId, (media) => ({
      ...media,
      status: "processing",
      error: null,
    }));

    const metadata = await runFfprobe(rawPath);
    console.info("[media] ffprobe complete", { projectId, mediaId });
    await generateProxyVideo(rawPath, proxyPath, metadata.hasAudio);
    console.info("[media] proxy generation complete", { projectId, mediaId });

    const relativeAudioPath = metadata.hasAudio ? path.posix.join("audio", audioFileName) : null;
    if (metadata.hasAudio) {
      await extractNormalizedAudio(rawPath, audioPath);
      console.info("[media] audio extraction complete", { projectId, mediaId });
    }

    const readyMedia: ProjectMediaEntry = {
      ...initialMedia,
      ...metadata,
      audioPath: relativeAudioPath,
      status: "ready",
      error: null,
    };
    await updateProjectMediaEntry(projectId, mediaId, () => readyMedia);
    console.info("[media] ready", { projectId, mediaId });

    return toMediaResult(readyMedia);
  } catch (error) {
    await markMediaFailed(projectId, mediaId, error);
    throw new ProjectServiceError(
      error instanceof Error ? error.message : "Unable to import and process media.",
    );
  }
}

export function isProjectServiceError(error: unknown): error is ProjectServiceError | StorageError {
  return error instanceof ProjectServiceError || error instanceof StorageError;
}
