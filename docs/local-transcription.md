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
