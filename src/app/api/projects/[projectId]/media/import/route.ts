import { isProjectServiceError, importProjectMedia } from "@/lib/projects/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ImportMediaRequestBody {
  path?: unknown;
}

interface ImportMediaRouteContext {
  params: Promise<{ projectId: string }>;
}

export async function POST(
  request: Request,
  context: ImportMediaRouteContext,
) {
  let body: ImportMediaRequestBody;

  try {
    body = (await request.json()) as ImportMediaRequestBody;
  } catch {
    return Response.json({ success: false, error: "Request body must be valid JSON." }, { status: 400 });
  }

  if (typeof body.path !== "string" || body.path.trim() === "") {
    return Response.json(
      { success: false, error: 'Request body must include a non-empty string "path".' },
      { status: 400 },
    );
  }

  const { projectId } = await context.params;
  try {
    const media = await importProjectMedia(projectId, body.path);
    return Response.json({ success: true, media });
  } catch (error) {
    const message = isProjectServiceError(error) ? error.message : "Unable to import media.";
    return Response.json({ success: false, error: message }, { status: 400 });
  }
}
