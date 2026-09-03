import { createProject, isProjectServiceError } from "@/lib/projects/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CreateProjectRequestBody {
  projectId?: unknown;
}

export async function POST(request: Request) {
  let body: CreateProjectRequestBody;

  try {
    body = (await request.json()) as CreateProjectRequestBody;
  } catch {
    return Response.json({ success: false, error: "Request body must be valid JSON." }, { status: 400 });
  }

  if (typeof body.projectId !== "string" || body.projectId.trim() === "") {
    return Response.json(
      { success: false, error: 'Request body must include a non-empty string "projectId".' },
      { status: 400 },
    );
  }

  try {
    const project = await createProject(body.projectId);
    return Response.json({ success: true, project });
  } catch (error) {
    const message = isProjectServiceError(error) ? error.message : "Unable to create project.";
    return Response.json({ success: false, error: message }, { status: 400 });
  }
}
