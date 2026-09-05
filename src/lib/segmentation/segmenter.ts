import "server-only";

import type { RuntimeTranscriptSegment } from "@/lib/transcription/mlx-whisper";
import type { DetectedScene } from "@/lib/segmentation/pyscenedetect";

export const MIN_SEGMENT_SECONDS = 2;
export const TARGET_MIN_SECONDS = 4;
export const TARGET_MAX_SECONDS = 20;
export const HARD_MAX_SECONDS = 30;

const EPSILON = 0.01;

export type SegmentationMode = "visual+transcript" | "visual-only";
export type SegmentBoundaryReason =
  | "media_start"
  | "media_end"
  | "scene_cut"
  | "transcript_boundary"
  | "scene_and_transcript"
  | "duration_split";

export interface CandidateTranscript {
  text: string;
  segmentIds: number[];
}

export interface CandidateSegment {
  id: string;
  start: number;
  end: number;
  duration: number;
  transcript: CandidateTranscript;
  speech: { hasSpeech: boolean };
  visual: { sceneCount: number; sceneStartIndices: number[] };
  boundaryReason: { start: SegmentBoundaryReason; end: SegmentBoundaryReason };
}

interface BoundaryCandidate {
  time: number;
  scene: boolean;
  transcript: boolean;
  crossesSpeech: boolean;
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function boundaryReason(candidate: BoundaryCandidate | undefined, isFinal: boolean): SegmentBoundaryReason {
  if (isFinal) {
    return "media_end";
  }

  if (!candidate) {
    return "duration_split";
  }

  if (candidate.scene && candidate.transcript) {
    return "scene_and_transcript";
  }

  if (candidate.scene && !candidate.crossesSpeech) {
    return "scene_cut";
  }

  if (candidate.transcript) {
    return "transcript_boundary";
  }

  return "duration_split";
}

function intersects(start: number, end: number, otherStart: number, otherEnd: number): boolean {
  return otherStart < end - EPSILON && otherEnd > start + EPSILON;
}

function createBoundaries(
  scenes: DetectedScene[],
  transcript: RuntimeTranscriptSegment[],
): BoundaryCandidate[] {
  const boundaries = new Map<number, BoundaryCandidate>();

  const add = (time: number, kind: "scene" | "transcript") => {
    const key = rounded(time);
    const existing = boundaries.get(key) ?? {
      time: key,
      scene: false,
      transcript: false,
      crossesSpeech: false,
    };
    existing[kind] = true;
    boundaries.set(key, existing);
  };

  for (const scene of scenes.slice(0, -1)) {
    add(scene.end, "scene");
  }

  for (const segment of transcript) {
    add(segment.end, "transcript");
  }

  return [...boundaries.values()]
    .map((boundary) => ({
      ...boundary,
      crossesSpeech: transcript.some(
        (segment) => segment.start < boundary.time - EPSILON && segment.end > boundary.time + EPSILON,
      ),
    }))
    .sort((left, right) => left.time - right.time);
}

function scoreBoundary(boundary: BoundaryCandidate, idealEnd: number): number {
  let score = Math.abs(boundary.time - idealEnd);
  if (boundary.scene && !boundary.crossesSpeech) {
    score -= 1.5;
  }
  if (boundary.transcript) {
    score -= 1;
  }
  if (boundary.scene && boundary.crossesSpeech) {
    score += 1.5;
  }
  return score;
}

function chooseEnd(
  start: number,
  durationSeconds: number,
  boundaries: BoundaryCandidate[],
): { end: number; candidate?: BoundaryCandidate } {
  const remaining = durationSeconds - start;
  if (remaining <= TARGET_MAX_SECONDS + EPSILON) {
    return { end: durationSeconds };
  }

  const lowerBound = start + TARGET_MIN_SECONDS;
  const upperBound = Math.min(start + TARGET_MAX_SECONDS, durationSeconds - MIN_SEGMENT_SECONDS);
  const idealEnd = start + (TARGET_MIN_SECONDS + TARGET_MAX_SECONDS) / 2;
  const preferred = boundaries.filter(
    (boundary) => boundary.time >= lowerBound - EPSILON && boundary.time <= upperBound + EPSILON,
  );

  if (preferred.length > 0) {
    const candidate = preferred.reduce((best, boundary) =>
      scoreBoundary(boundary, idealEnd) < scoreBoundary(best, idealEnd) ? boundary : best,
    );
    return { end: candidate.time, candidate };
  }

  const hardUpperBound = Math.min(start + HARD_MAX_SECONDS, durationSeconds - MIN_SEGMENT_SECONDS);
  const permitted = boundaries.filter(
    (boundary) => boundary.time >= start + MIN_SEGMENT_SECONDS - EPSILON && boundary.time <= hardUpperBound + EPSILON,
  );
  if (permitted.length > 0) {
    const candidate = permitted.reduce((best, boundary) =>
      scoreBoundary(boundary, start + TARGET_MAX_SECONDS) < scoreBoundary(best, start + TARGET_MAX_SECONDS)
        ? boundary
        : best,
    );
    return { end: candidate.time, candidate };
  }

  return { end: Math.min(start + TARGET_MAX_SECONDS, durationSeconds) };
}

function getOverlappingTranscript(
  start: number,
  end: number,
  transcript: RuntimeTranscriptSegment[],
): RuntimeTranscriptSegment[] {
  return transcript.filter((segment) => intersects(start, end, segment.start, segment.end));
}

function getVisualMetadata(start: number, end: number, scenes: DetectedScene[]) {
  const sceneStartIndices = scenes.flatMap((scene, index) =>
    intersects(start, end, scene.start, scene.end) ? [index] : [],
  );
  return { sceneCount: sceneStartIndices.length, sceneStartIndices };
}

export function generateCandidateSegments(
  durationSeconds: number,
  scenes: DetectedScene[],
  transcript: RuntimeTranscriptSegment[] | undefined,
): CandidateSegment[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("Media duration must be a positive finite number.");
  }

  const normalizedTranscript = transcript ?? [];
  const boundaries = createBoundaries(scenes, normalizedTranscript);
  const segments: CandidateSegment[] = [];
  let start = 0;
  let startReason: SegmentBoundaryReason = "media_start";

  while (durationSeconds - start > EPSILON) {
    const choice = chooseEnd(start, durationSeconds, boundaries);
    const end = Math.min(durationSeconds, Math.max(start + EPSILON, choice.end));
    const overlappingTranscript = getOverlappingTranscript(start, end, normalizedTranscript);
    const segmentNumber = segments.length + 1;
    const isFinal = Math.abs(end - durationSeconds) <= EPSILON;
    const endReason = boundaryReason(choice.candidate, isFinal);

    segments.push({
      id: `seg_${String(segmentNumber).padStart(4, "0")}`,
      start: rounded(start),
      end: rounded(end),
      duration: rounded(end - start),
      transcript: {
        text: overlappingTranscript.map((segment) => segment.text.trim()).filter(Boolean).join(" "),
        segmentIds: overlappingTranscript.map((segment) => segment.id),
      },
      speech: { hasSpeech: overlappingTranscript.length > 0 },
      visual: getVisualMetadata(start, end, scenes),
      boundaryReason: { start: startReason, end: endReason },
    });

    if (isFinal) {
      break;
    }

    start = end;
    startReason = endReason;
  }

  return segments;
}
