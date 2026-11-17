#!/bin/sh
# Builds whisper.cpp's whisper-server and fetches the models the agent's speech recognition uses.
#
#   sh stt/install.sh          # with Vulkan (the GPU)
#   VULKAN=0 sh stt/install.sh # CPU only
#   JOBS=4 sh stt/install.sh   # fewer parallel jobs, where the number of processes is capped (Vulkan shaders fork many)
#
# Vulkan needs the Vulkan headers and loader, glslc (shaderc) and SPIRV-Headers to build, and a Vulkan driver to run.
# Running it again rebuilds and skips models already downloaded.
set -eu

# Pinned so a rebuild gives the server that was measured (see HANDOFF.md, step 5). Bump deliberately.
WHISPER_REPO=https://github.com/ggml-org/whisper.cpp
WHISPER_COMMIT=aba02defd6bb6ff5de63721c21e3456645c153e2
HF=https://huggingface.co

cd "$(dirname "$0")"
dir=$(pwd)

if [ ! -d whisper.cpp/.git ]; then
	git clone --filter=blob:none "$WHISPER_REPO" whisper.cpp
fi
git -C whisper.cpp fetch --quiet origin "$WHISPER_COMMIT"
git -C whisper.cpp checkout --quiet --detach "$WHISPER_COMMIT"

vulkan=ON
[ "${VULKAN:-1}" = 0 ] && vulkan=OFF
cmake -S whisper.cpp -B whisper.cpp/build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=ON -DGGML_VULKAN="$vulkan" -DWHISPER_BUILD_TESTS=OFF
cmake --build whisper.cpp/build -j "${JOBS:-$(nproc)}" --target whisper-server

mkdir -p models
fetch() { # <url> <file> <sha256>
	if [ -f "models/$2" ] && echo "$3  models/$2" | sha256sum -c --status; then
		echo "models/$2 is already there"
		return
	fi
	curl -fsSL --retry 3 -o "models/$2.part" "$1"
	echo "$3  models/$2.part" | sha256sum -c --quiet
	mv "models/$2.part" "models/$2"
}
fetch "$HF/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin" ggml-large-v3-turbo-q8_0.bin \
	317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1
fetch "$HF/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin" ggml-silero-v5.1.2.bin \
	29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf

echo "built $dir/whisper.cpp/build/bin/whisper-server"
