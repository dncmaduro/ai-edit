import { isSegmentationError, segmentProjectMedia } from "@/lib/segmentation/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SegmentRouteContext {
  params: Promise<{ projectId: string; mediaId: string }>;
}

export async function POST(_request: Request, context: SegmentRouteContext) {
  const { projectId, mediaId } = await context.params;

  try {
    const segmentation = await segmentProjectMedia(projectId, mediaId);
    return Response.json({ success: true, segmentation });
  } catch (error) {
    const message = isSegmentationError(error) ? error.message : "Unable to segment media.";
    return Response.json({ success: false, error: message }, { status: 400 });
  }
}
