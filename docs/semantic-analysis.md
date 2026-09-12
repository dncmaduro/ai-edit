# Gemini semantic analysis setup

M5 uses the official `@google/genai` JavaScript SDK server-side. Create a Gemini API key and configure it in `.env.local`; never use a `NEXT_PUBLIC_` variable for this key.

```sh
GEMINI_API_KEY=your-key
GEMINI_ANALYSIS_MODEL=gemini-3.5-flash-lite
# Optional, constrained to 1–8 concurrent candidate analyses:
GEMINI_ANALYSIS_CONCURRENCY=3
```

M5 uploads the existing project proxy (`proxy/<media-id>.mp4`) once through the Gemini Files API for each analysis job. It never uploads raw source media or the normalized WAV. Each M4 candidate is analyzed by a static video interval using its existing start/end timestamps and associated local transcript text. The temporary Gemini file reference is not persisted and is deleted after the job finishes; the provider may also apply its own file-expiration policy.

Responses use Gemini structured JSON output plus strict local Zod validation. The resulting artifact is written atomically to `analysis/<media-id>.semantic-index.json`. Failed candidate analyses remain as failed entries so partial results stay inspectable.

The API key is only checked for presence by `/api/health`; the endpoint never makes a paid Gemini request or returns the key.
