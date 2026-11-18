# The speech recognition model and the VAD model, as `voice.stt.model` and `voice.stt.vadModel` expect them.
{ fetchurl, linkFarm }:
linkFarm "stt-models" {
  "ggml-large-v3-turbo-q8_0.bin" = fetchurl {
    url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin";
    sha256 = "317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1";
  };
  "ggml-silero-v5.1.2.bin" = fetchurl {
    url = "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin";
    sha256 = "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf";
  };
}
