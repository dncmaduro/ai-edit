import { isFfmpegAvailable, isFfprobeAvailable } from "@/lib/media/ffmpeg";
import { getProjectRoot } from "@/lib/storage";
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
  const [projectRoot, ffmpeg, ffprobe] = await Promise.all([
    hasProjectRoot(),
    isFfmpegAvailable(),
    isFfprobeAvailable(),
  ]);

  return Response.json({
    status: projectRoot && ffmpeg && ffprobe ? "ok" : "degraded",
    projectRoot,
    ffmpeg,
    ffprobe,
  });
}
