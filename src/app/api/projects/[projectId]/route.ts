import { ManifestError } from "@/lib/projects/manifest";
import { getProject, isProjectServiceError } from "@/lib/projects/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ProjectRouteContext {
  params: Promise<{ projectId: string }>;
}

export async function GET(_request: Request, context: ProjectRouteContext) {
  const { projectId } = await context.params;

  try {
    const manifest = await getProject(projectId);
    return Response.json({
      success: true,
      project: {
        projectId: manifest.projectId,
        createdAt: manifest.createdAt,
        updatedAt: manifest.updatedAt,
        mediaCount: manifest.media.length,
        media: manifest.media,
      },
    });
  } catch (error) {
    const message =
      error instanceof ManifestError || isProjectServiceError(error)
        ? error.message
        : "Unable to read project.";
    const status = error instanceof ManifestError && error.message.includes("does not exist") ? 404 : 400;
    return Response.json({ success: false, error: message }, { status });
  }
}
