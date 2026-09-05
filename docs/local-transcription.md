# Local transcription setup

M3 uses [MLX Whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper) for local Apple Silicon transcription. It runs as a Python subprocess; the Next.js server remains Node.js/TypeScript.

Create an isolated Python environment outside this repository and install the runtime:

```sh
python3 -m venv "$HOME/.local/share/ai-video-editor/whisper-venv"
"$HOME/.local/share/ai-video-editor/whisper-venv/bin/python" -m pip install --upgrade pip
"$HOME/.local/share/ai-video-editor/whisper-venv/bin/python" -m pip install "mlx-whisper==0.4.3"
```

Configure the server in `.env.local`:

```sh
PROJECT_ROOT=/absolute/path/to/ai-video-data
WHISPER_MODEL=mlx-community/whisper-large-v3-turbo
WHISPER_PYTHON=/absolute/path/to/whisper-venv/bin/python
```

The model downloads to the runtime's standard Hugging Face cache on its first transcription. Do not place model files in this repository. MLX Whisper is invoked with word timestamps enabled; they are persisted only when the runtime returns valid timing data.

## Local scene detection setup

M4 uses [PySceneDetect](https://www.scenedetect.com/) in a separate local Python environment. The current stable release is `0.7.1`; it performs local content-based scene detection and does not send media anywhere.

```sh
python3 -m venv "$HOME/.local/share/ai-video-editor/scenedetect-venv"
"$HOME/.local/share/ai-video-editor/scenedetect-venv/bin/python" -m pip install --upgrade pip
"$HOME/.local/share/ai-video-editor/scenedetect-venv/bin/python" -m pip install "scenedetect==0.7.1"
```

Configure the server in `.env.local` when this differs from `python3`:

```sh
SCENEDETECT_PYTHON=/absolute/path/to/scenedetect-venv/bin/python
# Optional detector tuning:
SCENEDETECT_THRESHOLD=27
SCENEDETECT_MIN_SCENE_SECONDS=0.8
```

Scene detection runs as a one-off Python subprocess with argument arrays. Raw visual boundaries are stored in `analysis/<media-id>.scenes.json`; deterministic merged candidate clips are stored in `analysis/<media-id>.segments.json`.
