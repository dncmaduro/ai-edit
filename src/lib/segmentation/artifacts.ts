import "server-only";

import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getProjectAnalysisDir, resolveProjectRelativeFile, StorageError } from "@/lib/storage";
import {
  type CandidateSegment,
  type SegmentationMode,
  type SegmentBoundaryReason,
} from "@/lib/segmentation/segmenter";
import {
  type DetectedScene,
  getSceneDetectionConfig,
  SCENE_DETECTOR_NAME,
} from "@/lib/segmentation/pyscenedetect";

const TIMING_TOLERANCE_SECONDS = 0.05;

export interface SceneDetectorMetadata {
  name: typeof SCENE_DETECTOR_NAME;
  threshold: number;
  minSceneSeconds: number;
}

export interface SceneArtifact {
  version: 1;
  mediaId: string;
  durationSeconds: number;
  detector: SceneDetectorMetadata;
  scenes: DetectedScene[];
}

export interface SegmentsArtifact {
  version: 1;
  mediaId: string;
  durationSeconds: number;
  mode: SegmentationMode;
  scenesPath: string;
  segments: CandidateSegment[];
}

export class SegmentationArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SegmentationArtifactError";
  }
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRelativeProjectPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.split(/[\\/]/).includes("..")
  );
}

function isBoundaryReason(value: unknown): value is SegmentBoundaryReason {
  return (
    value === "media_start" ||
    value === "media_end" ||
    value === "scene_cut" ||
    value === "transcript_boundary" ||
    value === "scene_and_transcript" ||
    value === "duration_split"
  );
}

function assertValidScene(value: unknown, previousEnd: number, durationSeconds: number): asserts value is DetectedScene {
  if (!value || typeof value !== "object") {
    throw new SegmentationArtifactError("Scene artifact contains an invalid scene.");
  }

  const scene = value as Record<string, unknown>;
  if (
    !isFiniteNumber(scene.start) ||
    !isFiniteNumber(scene.end) ||
    scene.start < 0 ||
    scene.start >= scene.end ||
    scene.start < previousEnd - TIMING_TOLERANCE_SECONDS ||
    scene.end > durationSeconds + TIMING_TOLERANCE_SECONDS
  ) {
    throw new SegmentationArtifactError("Scene artifact contains invalid scene timestamps.");
  }
}

function assertValidCandidateSegment(
  value: unknown,
  index: number,
  previousEnd: number,
  durationSeconds: number,
): asserts value is CandidateSegment {
  if (!value || typeof value !== "object") {
    throw new SegmentationArtifactError("Segments artifact contains an invalid candidate segment.");
  }

  const segment = value as Record<string, unknown>;
  const expectedId = `seg_${String(index + 1).padStart(4, "0")}`;
  const transcript =
    segment.transcript && typeof segment.transcript === "object"
      ? (segment.transcript as Record<string, unknown>)
      : undefined;
  const speech =
    segment.speech && typeof segment.speech === "object"
      ? (segment.speech as Record<string, unknown>)
      : undefined;
  const visual =
    segment.visual && typeof segment.visual === "object"
      ? (segment.visual as Record<string, unknown>)
      : undefined;
  const boundaryReason =
    segment.boundaryReason && typeof segment.boundaryReason === "object"
      ? (segment.boundaryReason as Record<string, unknown>)
      : undefined;
  if (
    segment.id !== expectedId ||
    !isFiniteNumber(segment.start) ||
    !isFiniteNumber(segment.end) ||
    !isFiniteNumber(segment.duration) ||
    segment.start < 0 ||
    segment.start >= segment.end ||
    Math.abs(segment.duration - (segment.end - segment.start)) > TIMING_TOLERANCE_SECONDS ||
    segment.start < previousEnd - TIMING_TOLERANCE_SECONDS ||
    segment.end > durationSeconds + TIMING_TOLERANCE_SECONDS ||
    !transcript ||
    typeof transcript.text !== "string" ||
    !Array.isArray(transcript.segmentIds) ||
    !transcript.segmentIds.every(isFiniteNumber) ||
    !speech ||
    typeof speech.hasSpeech !== "boolean" ||
    !visual ||
    !Number.isInteger(visual.sceneCount) ||
    (visual.sceneCount as number) < 0 ||
    !Array.isArray(visual.sceneStartIndices) ||
    !visual.sceneStartIndices.every(
      (sceneIndex: unknown) => Number.isInteger(sceneIndex) && (sceneIndex as number) >= 0,
    ) ||
    visual.sceneCount !== visual.sceneStartIndices.length ||
    !boundaryReason ||
    !isBoundaryReason(boundaryReason.start) ||
    !isBoundaryReason(boundaryReason.end)
  ) {
    throw new SegmentationArtifactError("Segments artifact contains invalid candidate segment data.");
  }
}

export function assertValidSceneArtifact(value: unknown): asserts value is SceneArtifact {
  if (!value || typeof value !== "object") {
    throw new SegmentationArtifactError("Scene artifact must contain an object.");
  }

  const artifact = value as Record<string, unknown>;
  if (
    artifact.version !== 1 ||
    !isUuid(artifact.mediaId) ||
    !isFiniteNumber(artifact.durationSeconds) ||
    artifact.durationSeconds <= 0 ||
    !artifact.detector ||
    typeof artifact.detector !== "object" ||
    (artifact.detector as Record<string, unknown>).name !== SCENE_DETECTOR_NAME ||
    !isFiniteNumber((artifact.detector as Record<string, unknown>).threshold) ||
    !isFiniteNumber((artifact.detector as Record<string, unknown>).minSceneSeconds) ||
    !Array.isArray(artifact.scenes) ||
    artifact.scenes.length === 0
  ) {
    throw new SegmentationArtifactError("Scene artifact has an invalid shape.");
  }

  let previousEnd = 0;
  for (const scene of artifact.scenes) {
    assertValidScene(scene, previousEnd, artifact.durationSeconds);
    previousEnd = scene.end;
  }

  if (
    Math.abs((artifact.scenes[0] as DetectedScene).start) > TIMING_TOLERANCE_SECONDS ||
    Math.abs(previousEnd - artifact.durationSeconds) > TIMING_TOLERANCE_SECONDS
  ) {
    throw new SegmentationArtifactError("Scene artifact must cover the full media duration.");
  }
}

export function assertValidSegmentsArtifact(value: unknown): asserts value is SegmentsArtifact {
  if (!value || typeof value !== "object") {
    throw new SegmentationArtifactError("Segments artifact must contain an object.");
  }

  const artifact = value as Record<string, unknown>;
  if (
    artifact.version !== 1 ||
    !isUuid(artifact.mediaId) ||
    !isFiniteNumber(artifact.durationSeconds) ||
    artifact.durationSeconds <= 0 ||
    (artifact.mode !== "visual+transcript" && artifact.mode !== "visual-only") ||
    !isRelativeProjectPath(artifact.scenesPath) ||
    !Array.isArray(artifact.segments) ||
    artifact.segments.length === 0
  ) {
    throw new SegmentationArtifactError("Segments artifact has an invalid shape.");
  }

  let previousEnd = 0;
  for (const [index, segment] of artifact.segments.entries()) {
    assertValidCandidateSegment(segment, index, previousEnd, artifact.durationSeconds);
    previousEnd = (segment as CandidateSegment).end;
  }

  if (
    Math.abs((artifact.segments[0] as CandidateSegment).start) > TIMING_TOLERANCE_SECONDS ||
    Math.abs(previousEnd - artifact.durationSeconds) > TIMING_TOLERANCE_SECONDS
  ) {
    throw new SegmentationArtifactError("Segments artifact must cover the full media duration.");
  }
}

export function normalizeDetectedScenes(
  detectedScenes: DetectedScene[],
  durationSeconds: number,
): DetectedScene[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || detectedScenes.length === 0) {
    throw new SegmentationArtifactError("Cannot normalize invalid scene detection output.");
  }

  const cutPoints = detectedScenes
    .slice(0, -1)
    .map((scene) => scene.end)
    .filter((cut) => cut > TIMING_TOLERANCE_SECONDS && cut < durationSeconds - TIMING_TOLERANCE_SECONDS)
    .sort((left, right) => left - right)
    .filter((cut, index, all) => index === 0 || cut - all[index - 1] > TIMING_TOLERANCE_SECONDS);

  const boundaries = [0, ...cutPoints, durationSeconds];
  return boundaries.slice(0, -1).map((start, index) => ({ start, end: boundaries[index + 1] }));
}

export function createSceneArtifact(
  mediaId: string,
  durationSeconds: number,
  scenes: DetectedScene[],
): SceneArtifact {
  const config = getSceneDetectionConfig();
  const artifact: SceneArtifact = {
    version: 1,
    mediaId,
    durationSeconds,
    detector: {
      name: SCENE_DETECTOR_NAME,
      threshold: config.threshold,
      minSceneSeconds: config.minSceneSeconds,
    },
    scenes: normalizeDetectedScenes(scenes, durationSeconds),
  };
  assertValidSceneArtifact(artifact);
  return artifact;
}

export function createSegmentsArtifact(
  mediaId: string,
  durationSeconds: number,
  mode: SegmentationMode,
  scenesPath: string,
  segments: CandidateSegment[],
): SegmentsArtifact {
  const artifact: SegmentsArtifact = {
    version: 1,
    mediaId,
    durationSeconds,
    mode,
    scenesPath,
    segments,
  };
  assertValidSegmentsArtifact(artifact);
  return artifact;
}

export function getScenesRelativePath(mediaId: string): string {
  if (!isUuid(mediaId)) {
    throw new SegmentationArtifactError("Media ID is invalid for scene persistence.");
  }

  return path.posix.join("analysis", `${mediaId}.scenes.json`);
}

export function getSegmentsRelativePath(mediaId: string): string {
  if (!isUuid(mediaId)) {
    throw new SegmentationArtifactError("Media ID is invalid for segment persistence.");
  }

  return path.posix.join("analysis", `${mediaId}.segments.json`);
}

async function writeArtifact(
  projectId: string,
  fileName: string,
  artifact: SceneArtifact | SegmentsArtifact,
): Promise<void> {
  const analysisDir = getProjectAnalysisDir(projectId);
  const outputPath = path.join(analysisDir, fileName);
  const tempPath = path.join(analysisDir, `.${fileName}-${randomUUID()}.tmp`);

  try {
    await writeFile(tempPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    await rename(tempPath, outputPath);
  } catch {
    throw new SegmentationArtifactError("Unable to write segmentation artifact.");
  }
}

export async function writeProjectSceneArtifact(projectId: string, artifact: SceneArtifact): Promise<string> {
  assertValidSceneArtifact(artifact);
  const relativePath = getScenesRelativePath(artifact.mediaId);
  await writeArtifact(projectId, path.basename(relativePath), artifact);
  return relativePath;
}

export async function writeProjectSegmentsArtifact(
  projectId: string,
  artifact: SegmentsArtifact,
): Promise<string> {
  assertValidSegmentsArtifact(artifact);
  const relativePath = getSegmentsRelativePath(artifact.mediaId);
  await writeArtifact(projectId, path.basename(relativePath), artifact);
  return relativePath;
}

async function readArtifact(projectId: string, relativePath: string): Promise<unknown> {
  let artifactPath: string;
  try {
    artifactPath = await resolveProjectRelativeFile(projectId, relativePath);
  } catch (error) {
    if (error instanceof StorageError) {
      throw new SegmentationArtifactError(error.message);
    }
    throw error;
  }

  try {
    return JSON.parse(await readFile(artifactPath, "utf8"));
  } catch {
    throw new SegmentationArtifactError("Segmentation artifact contains invalid JSON or cannot be read.");
  }
}

export async function readProjectSceneArtifact(
  projectId: string,
  relativePath: string,
  expectedMediaId: string,
): Promise<SceneArtifact> {
  const artifact = await readArtifact(projectId, relativePath);
  assertValidSceneArtifact(artifact);
  if (artifact.mediaId !== expectedMediaId) {
    throw new SegmentationArtifactError("Scene artifact media ID does not match its manifest entry.");
  }
  return artifact;
}

export async function readProjectSegmentsArtifact(
  projectId: string,
  relativePath: string,
  expectedMediaId: string,
): Promise<SegmentsArtifact> {
  const artifact = await readArtifact(projectId, relativePath);
  assertValidSegmentsArtifact(artifact);
  if (artifact.mediaId !== expectedMediaId) {
    throw new SegmentationArtifactError("Segments artifact media ID does not match its manifest entry.");
  }
  return artifact;
}
