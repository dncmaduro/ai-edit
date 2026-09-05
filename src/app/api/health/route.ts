import { isFfmpegAvailable, isFfprobeAvailable } from "@/lib/media/ffmpeg";
import { getProjectRoot } from "@/lib/storage";
import { checkSceneDetectionRuntime } from "@/lib/segmentation/pyscenedetect";
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
  const [projectRoot, ffmpeg, ffprobe, transcription, sceneDetection] = await Promise.all([
    hasProjectRoot(),
    isFfmpegAvailable(),
    isFfprobeAvailable(),
    checkTranscriptionRuntime(),
    checkSceneDetectionRuntime(),
  ]);

  return Response.json({
    status: projectRoot && ffmpeg && ffprobe && transcription.available && sceneDetection.available ? "ok" : "degraded",
    projectRoot,
    ffmpeg,
    ffprobe,
    transcription,
    sceneDetection,
  });
}
