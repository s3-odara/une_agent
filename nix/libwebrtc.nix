# The prebuilt libwebrtc that webrtc-sys would download during the build, which the sandbox does not allow. The tag is
# `WEBRTC_TAG` of the webrtc-sys-build crate in gateway/Cargo.lock; bump both together.
{ fetchzip }:
fetchzip {
  url = "https://github.com/livekit/rust-sdks/releases/download/webrtc-a545de4/webrtc-linux-x64-release.zip";
  hash = "sha256-vPpThrBeJVzcnRWxAqZTWBPz3wOAzaZZJFG6bvKPN64=";
}
