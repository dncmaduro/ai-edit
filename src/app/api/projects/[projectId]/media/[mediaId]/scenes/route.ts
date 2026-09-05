import { getProjectMediaScenes, isSegmentationError } from "@/lib/segmentation/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ScenesRouteContext {
  params: Promise<{ projectId: string; mediaId: string }>;
}

export async function GET(_request: Request, context: ScenesRouteContext) {
  const { projectId, mediaId } = await context.params;

  try {
    const scenes = await getProjectMediaScenes(projectId, mediaId);
    return Response.json({ success: true, scenes });
  } catch (error) {
    const message = isSegmentationError(error) ? error.message : "Unable to read scene detection artifact.";
    const status = message.startsWith("Segmentation failed:")
      ? 409
      : message.includes("does not exist")
        ? 404
        : 400;
    return Response.json({ success: false, error: message }, { status });
  }
}
