import "server-only";

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const TRANSCRIPTION_RUNTIME = "mlx-whisper";
export const DEFAULT_WHISPER_MODEL = "mlx-community/whisper-large-v3-turbo";

export interface TranscriptionRuntimeConfig {
  runtime: typeof TRANSCRIPTION_RUNTIME;
  model: string;
  pythonCommand: string;
}

export interface TranscriptionRuntimeStatus {
  runtime: typeof TRANSCRIPTION_RUNTIME;
  available: boolean;
  model: string;
  error?: string;
}

export interface RuntimeTranscriptWord {
  word: string;
  start: number;
  end: number;
}

export interface RuntimeTranscriptSegment {
  id: number;
  start: number;
  end: number;
  text: string;
  words?: RuntimeTranscriptWord[];
}

export interface RuntimeTranscript {
  language: string;
  durationSeconds: number;
  segments: RuntimeTranscriptSegment[];
}

export class TranscriptionRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptionRuntimeError";
  }
}

export function getTranscriptionRuntimeConfig(): TranscriptionRuntimeConfig {
  return {
    runtime: TRANSCRIPTION_RUNTIME,
    model: process.env.WHISPER_MODEL?.trim() || DEFAULT_WHISPER_MODEL,
    pythonCommand: process.env.WHISPER_PYTHON?.trim() || "python3",
  };
}

export async function checkTranscriptionRuntime(): Promise<TranscriptionRuntimeStatus> {
  const config = getTranscriptionRuntimeConfig();

  try {
    await execFileAsync(config.pythonCommand, ["-c", "import mlx_whisper"], { timeout: 5_000 });
    return { runtime: config.runtime, available: true, model: config.model };
  } catch {
    return {
      runtime: config.runtime,
      available: false,
      model: config.model,
      error: "MLX Whisper is unavailable. Install it and configure WHISPER_PYTHON if needed.",
    };
  }
}

function asRecord(value: unknown, description: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new TranscriptionRuntimeError(`MLX Whisper returned an invalid ${description}.`);
  }

  return value as Record<string, unknown>;
}

function asFiniteNumber(value: unknown, description: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TranscriptionRuntimeError(`MLX Whisper returned an invalid ${description}.`);
  }

  return value;
}

function parseWords(value: unknown, segmentStart: number, segmentEnd: number): RuntimeTranscriptWord[] | undefined {
  if (value === undefined || !Array.isArray(value)) {
    return undefined;
  }

  let previousEnd = segmentStart;
  const words: RuntimeTranscriptWord[] = [];
  for (const wordValue of value) {
    if (!wordValue || typeof wordValue !== "object") {
      return undefined;
    }

    const word = wordValue as Record<string, unknown>;
    const text = typeof word.word === "string" ? word.word.trim() : "";
    const start = typeof word.start === "number" ? word.start : Number.NaN;
    const end = typeof word.end === "number" ? word.end : Number.NaN;
    if (
      !text ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start >= end ||
      start < segmentStart - 0.01 ||
      end > segmentEnd + 0.01 ||
      start < previousEnd
    ) {
      return undefined;
    }

    previousEnd = end;
    words.push({ word: text, start, end });
  }

  return words.length > 0 ? words : undefined;
}

export function parseMlxWhisperTranscript(output: string): RuntimeTranscript {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new TranscriptionRuntimeError("MLX Whisper returned invalid JSON.");
  }

  const transcript = asRecord(parsed, "transcript");
  const language = typeof transcript.language === "string" ? transcript.language.trim() : "";
  if (!language || !Array.isArray(transcript.segments)) {
    throw new TranscriptionRuntimeError("MLX Whisper transcript is missing language or segments.");
  }

  let previousEnd = 0;
  const segments = transcript.segments.flatMap((segmentValue) => {
    const segment = asRecord(segmentValue, "segment");
    const id = asFiniteNumber(segment.id, "segment ID");
    const start = asFiniteNumber(segment.start, "segment start timestamp");
    const end = asFiniteNumber(segment.end, "segment end timestamp");
    const text = typeof segment.text === "string" ? segment.text.trim() : "";

    if (start < 0 || start >= end || start < previousEnd) {
      throw new TranscriptionRuntimeError("MLX Whisper returned invalid segment timestamp ordering.");
    }

    previousEnd = end;
    if (!text) {
      return [];
    }

    const words = parseWords(segment.words, start, end);
    return [{ id, start, end, text, ...(words ? { words } : {}) }];
  });

  return { language, durationSeconds: previousEnd, segments };
}

export async function transcribeAudio(audioPath: string): Promise<RuntimeTranscript> {
  const config = getTranscriptionRuntimeConfig();
  const runtime = await checkTranscriptionRuntime();
  if (!runtime.available) {
    throw new TranscriptionRuntimeError(runtime.error ?? "MLX Whisper is unavailable.");
  }

  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "ai-edit-mlx-whisper-"));
  const outputPath = path.join(outputDirectory, "transcript.json");

  try {
    await execFileAsync(
      config.pythonCommand,
      [
        "-m",
        "mlx_whisper.cli",
        audioPath,
        "--model",
        config.model,
        "--output-dir",
        outputDirectory,
        "--output-name",
        "transcript",
        "--output-format",
        "json",
        "--word-timestamps",
        "True",
        "--language",
        "vi",
        "--verbose",
        "False",
      ],
      { maxBuffer: 10 * 1024 * 1024, timeout: 60 * 60_000 },
    );

    return parseMlxWhisperTranscript(await readFile(outputPath, "utf8"));
  } catch (error) {
    if (error instanceof TranscriptionRuntimeError) {
      throw error;
    }

    const stderr =
      typeof (error as { stderr?: unknown }).stderr === "string"
        ? (error as { stderr: string }).stderr.trim().slice(-1_000)
        : "";
    throw new TranscriptionRuntimeError(
      `MLX Whisper transcription failed.${stderr ? ` ${stderr}` : ""}`,
    );
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}
