import {
  isTranscriptionError,
  transcribeProjectMedia,
} from "@/lib/transcription/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface TranscribeRouteContext {
  params: Promise<{ projectId: string; mediaId: string }>;
}

export async function POST(_request: Request, context: TranscribeRouteContext) {
  const { projectId, mediaId } = await context.params;

  try {
    const transcription = await transcribeProjectMedia(projectId, mediaId);
    return Response.json({ success: true, transcription });
  } catch (error) {
    const message = isTranscriptionError(error) ? error.message : "Unable to transcribe media.";
    return Response.json({ success: false, error: message }, { status: 400 });
  }
}
