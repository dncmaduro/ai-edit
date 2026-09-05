import {
  getProjectMediaTranscript,
  isTranscriptionError,
} from "@/lib/transcription/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface TranscriptRouteContext {
  params: Promise<{ projectId: string; mediaId: string }>;
}

export async function GET(_request: Request, context: TranscriptRouteContext) {
  const { projectId, mediaId } = await context.params;

  try {
    const transcript = await getProjectMediaTranscript(projectId, mediaId);
    return Response.json({ success: true, transcript });
  } catch (error) {
    const message = isTranscriptionError(error) ? error.message : "Unable to read transcript.";
    const status = message.startsWith("Transcription failed:")
      ? 409
      : message.includes("does not exist")
        ? 404
        : 400;
    return Response.json({ success: false, error: message }, { status });
  }
}
