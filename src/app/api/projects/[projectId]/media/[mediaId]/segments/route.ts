import { getProjectMediaSegments, isSegmentationError } from "@/lib/segmentation/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SegmentsRouteContext {
  params: Promise<{ projectId: string; mediaId: string }>;
}

export async function GET(_request: Request, context: SegmentsRouteContext) {
  const { projectId, mediaId } = await context.params;

  try {
    const segments = await getProjectMediaSegments(projectId, mediaId);
    return Response.json({ success: true, segments });
  } catch (error) {
    const message = isSegmentationError(error) ? error.message : "Unable to read candidate segments artifact.";
    const status = message.startsWith("Segmentation failed:")
      ? 409
      : message.includes("does not exist")
        ? 404
        : 400;
    return Response.json({ success: false, error: message }, { status });
  }
}
