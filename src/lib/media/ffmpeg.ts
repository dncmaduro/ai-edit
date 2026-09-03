import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface MediaMetadata {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
}

interface FfprobeResponse {
  format?: { duration?: string };
  streams?: FfprobeStream[];
}

export class MediaProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaProbeError";
  }
}

export class MediaProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaProcessingError";
  }
}

async function isCommandAvailable(command: "ffmpeg" | "ffprobe"): Promise<boolean> {
  try {
    await execFileAsync(command, ["-version"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export function isFfmpegAvailable(): Promise<boolean> {
  return isCommandAvailable("ffmpeg");
}

export function isFfprobeAvailable(): Promise<boolean> {
  return isCommandAvailable("ffprobe");
}

function toFiniteNumber(value: string | number | undefined): number | null {
  if (value === undefined) {
    return null;
  }

  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseFrameRate(value: string | undefined): number | null {
  if (!value || value === "0/0") {
    return null;
  }

  const [numerator, denominator] = value.split("/");
  if (denominator !== undefined) {
    const parsedNumerator = Number.parseFloat(numerator);
    const parsedDenominator = Number.parseFloat(denominator);

    if (!Number.isFinite(parsedNumerator) || !Number.isFinite(parsedDenominator) || parsedDenominator === 0) {
      return null;
    }

    return parsedNumerator / parsedDenominator;
  }

  return toFiniteNumber(value);
}

export function parseFfprobeJson(output: string): MediaMetadata {
  let probe: FfprobeResponse;

  try {
    probe = JSON.parse(output) as FfprobeResponse;
  } catch {
    throw new MediaProbeError("ffprobe returned invalid JSON.");
  }

  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const videoStream = streams.find((stream) => stream.codec_type === "video");
  const audioStream = streams.find((stream) => stream.codec_type === "audio");
  const durationSeconds =
    toFiniteNumber(probe.format?.duration) ?? toFiniteNumber(videoStream?.duration);

  return {
    durationSeconds,
    width: toFiniteNumber(videoStream?.width),
    height: toFiniteNumber(videoStream?.height),
    fps: parseFrameRate(videoStream?.avg_frame_rate ?? videoStream?.r_frame_rate),
    videoCodec: videoStream?.codec_name ?? null,
    audioCodec: audioStream?.codec_name ?? null,
    hasAudio: audioStream !== undefined,
  };
}

export async function runFfprobe(videoPath: string): Promise<MediaMetadata> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        videoPath,
      ],
      { maxBuffer: 10 * 1024 * 1024, timeout: 30_000 },
    );

    return parseFfprobeJson(stdout);
  } catch (error) {
    if (error instanceof MediaProbeError) {
      throw error;
    }

    throw new MediaProbeError("ffprobe could not inspect the media file.");
  }
}

async function runFfmpeg(args: string[], operation: string): Promise<void> {
  try {
    await execFileAsync("ffmpeg", ["-nostdin", ...args], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 10 * 60_000,
    });
  } catch (error) {
    const stderr =
      typeof (error as { stderr?: unknown }).stderr === "string"
        ? (error as { stderr: string }).stderr.trim().slice(-1_000)
        : "";
    const details = stderr ? ` ${stderr}` : "";

    throw new MediaProcessingError(`FFmpeg ${operation} failed.${details}`);
  }
}

export async function generateProxyVideo(
  sourcePath: string,
  outputPath: string,
  hasAudio: boolean,
): Promise<void> {
  const args = [
    "-n",
    "-i",
    sourcePath,
    "-map",
    "0:v:0",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-vf",
    "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
  ];

  if (hasAudio) {
    args.push("-map", "0:a:0?", "-c:a", "aac", "-b:a", "128k");
  } else {
    args.push("-an");
  }

  args.push("-movflags", "+faststart", outputPath);
  await runFfmpeg(args, "proxy generation");
}

export async function extractNormalizedAudio(
  sourcePath: string,
  outputPath: string,
): Promise<void> {
  await runFfmpeg(
    [
      "-n",
      "-i",
      sourcePath,
      "-map",
      "0:a:0",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      outputPath,
    ],
    "audio extraction",
  );
}
