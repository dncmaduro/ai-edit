import { isFfmpegAvailable, isFfprobeAvailable } from "@/lib/media/ffmpeg";
import { getProjectRoot } from "@/lib/storage";
import { checkTranscriptionRuntime } from "@/lib/transcription/mlx-whisper";
import { stat } from "node:fs/promises";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function hasProjectRoot(): Promise<boolean> {
  try {
    const rootInfo = await stat(getProjectRoot());
    return rootInfo.isDirectory();
  } catch {
    return false;
  }
}

export async function GET() {
  const [projectRoot, ffmpeg, ffprobe, transcription] = await Promise.all([
    hasProjectRoot(),
    isFfmpegAvailable(),
    isFfprobeAvailable(),
    checkTranscriptionRuntime(),
  ]);

  return Response.json({
    status: projectRoot && ffmpeg && ffprobe && transcription.available ? "ok" : "degraded",
    projectRoot,
    ffmpeg,
    ffprobe,
    transcription,
  });
}
