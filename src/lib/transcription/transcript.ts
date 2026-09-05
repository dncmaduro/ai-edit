import "server-only";

import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getProjectAnalysisDir,
  resolveProjectRelativeFile,
  StorageError,
} from "@/lib/storage";
import type { RuntimeTranscript } from "@/lib/transcription/mlx-whisper";

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

export interface TranscriptSegment {
  id: number;
  start: number;
  end: number;
  text: string;
  words?: TranscriptWord[];
}

export interface ProjectTranscript {
  version: 1;
  mediaId: string;
  language: string;
  durationSeconds: number;
  model: string;
  segments: TranscriptSegment[];
}

export class TranscriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptError";
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

function isTranscriptWord(value: unknown, segmentStart: number, segmentEnd: number): value is TranscriptWord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const word = value as Record<string, unknown>;
  return (
    typeof word.word === "string" &&
    word.word.trim().length > 0 &&
    isFiniteNumber(word.start) &&
    isFiniteNumber(word.end) &&
    word.start < word.end &&
    word.start >= segmentStart - 0.01 &&
    word.end <= segmentEnd + 0.01
  );
}

function isTranscriptSegment(value: unknown, previousEnd: number): value is TranscriptSegment {
  if (!value || typeof value !== "object") {
    return false;
  }

  const segment = value as Record<string, unknown>;
  if (
    !isFiniteNumber(segment.id) ||
    !isFiniteNumber(segment.start) ||
    !isFiniteNumber(segment.end) ||
    segment.start < previousEnd ||
    segment.start >= segment.end ||
    typeof segment.text !== "string" ||
    segment.text.trim().length === 0
  ) {
    return false;
  }

  const segmentStart = segment.start;
  const segmentEnd = segment.end;
  if (!Array.isArray(segment.words)) {
    return segment.words === undefined;
  }

  let previousWordEnd = segmentStart;
  return segment.words.every((word) => {
    if (!isTranscriptWord(word, segmentStart, segmentEnd)) {
      return false;
    }

    if (word.start < previousWordEnd) {
      return false;
    }

    previousWordEnd = word.end;
    return true;
  });
}

export function assertValidProjectTranscript(value: unknown): asserts value is ProjectTranscript {
  if (!value || typeof value !== "object") {
    throw new TranscriptError("Transcript must contain an object.");
  }

  const transcript = value as Record<string, unknown>;
  if (
    transcript.version !== 1 ||
    !isUuid(transcript.mediaId) ||
    typeof transcript.language !== "string" ||
    transcript.language.trim().length === 0 ||
    !isFiniteNumber(transcript.durationSeconds) ||
    transcript.durationSeconds < 0 ||
    typeof transcript.model !== "string" ||
    transcript.model.trim().length === 0 ||
    !Array.isArray(transcript.segments)
  ) {
    throw new TranscriptError("Transcript has an invalid shape.");
  }

  let previousEnd = 0;
  for (const segment of transcript.segments) {
    if (!isTranscriptSegment(segment, previousEnd)) {
      throw new TranscriptError("Transcript contains invalid or unordered segment timestamps.");
    }

    previousEnd = segment.end;
  }
}

export function createProjectTranscript(
  mediaId: string,
  model: string,
  durationSeconds: number | null,
  runtimeTranscript: RuntimeTranscript,
): ProjectTranscript {
  const transcript: ProjectTranscript = {
    version: 1,
    mediaId,
    language: runtimeTranscript.language,
    durationSeconds: durationSeconds ?? runtimeTranscript.durationSeconds,
    model,
    segments: runtimeTranscript.segments,
  };
  assertValidProjectTranscript(transcript);
  return transcript;
}

export function getTranscriptRelativePath(mediaId: string): string {
  if (!isUuid(mediaId)) {
    throw new TranscriptError("Media ID is invalid for transcript persistence.");
  }

  return path.posix.join("analysis", `${mediaId}.transcript.json`);
}

export async function writeProjectTranscript(
  projectId: string,
  transcript: ProjectTranscript,
): Promise<string> {
  assertValidProjectTranscript(transcript);
  const relativePath = getTranscriptRelativePath(transcript.mediaId);
  const outputPath = path.join(getProjectAnalysisDir(projectId), `${transcript.mediaId}.transcript.json`);
  const tempPath = path.join(getProjectAnalysisDir(projectId), `.transcript-${randomUUID()}.tmp`);

  try {
    await writeFile(tempPath, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");
    await rename(tempPath, outputPath);
  } catch {
    throw new TranscriptError("Unable to write transcript artifact.");
  }

  return relativePath;
}

export async function readProjectTranscript(
  projectId: string,
  relativePath: string,
  expectedMediaId: string,
): Promise<ProjectTranscript> {
  let transcriptPath: string;
  try {
    transcriptPath = await resolveProjectRelativeFile(projectId, relativePath);
  } catch (error) {
    if (error instanceof StorageError) {
      throw new TranscriptError(error.message);
    }

    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(transcriptPath, "utf8"));
  } catch {
    throw new TranscriptError("Transcript artifact contains invalid JSON or cannot be read.");
  }

  assertValidProjectTranscript(parsed);
  if (parsed.mediaId !== expectedMediaId) {
    throw new TranscriptError("Transcript media ID does not match its manifest entry.");
  }

  return parsed;
}
