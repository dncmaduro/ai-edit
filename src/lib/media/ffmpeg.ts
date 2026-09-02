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
