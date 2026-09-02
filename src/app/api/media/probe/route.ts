import { runFfprobe } from "@/lib/media/ffmpeg";
import { resolveProjectMediaFile, StorageError } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ProbeRequestBody {
  path?: unknown;
}

export async function POST(request: Request) {
  let body: ProbeRequestBody;

  try {
    body = (await request.json()) as ProbeRequestBody;
  } catch {
    return Response.json({ success: false, error: "Request body must be valid JSON." }, { status: 400 });
  }

  if (typeof body.path !== "string" || body.path.trim() === "") {
    return Response.json(
      { success: false, error: 'Request body must include a non-empty string "path".' },
      { status: 400 },
    );
  }

  try {
    const mediaPath = await resolveProjectMediaFile(body.path);
    const metadata = await runFfprobe(mediaPath);

    return Response.json({ success: true, metadata });
  } catch (error) {
    const message =
      error instanceof StorageError ? error.message : "Unable to probe the requested media file.";

    return Response.json({ success: false, error: message }, { status: 400 });
  }
}
