use std::collections::VecDeque;
use std::path::Path;

use anyhow::{Context, Result};
use serde::Deserialize;

/// As LiveKit hands it over and takes it.
pub const SAMPLE_RATE: u32 = 48_000;
/// What the VAD (and the speech recognizer) work at.
pub const VAD_RATE: u32 = 16_000;
pub const FRAME_MS: u32 = 16;
pub const FRAME_SAMPLES: usize = (VAD_RATE / 1000 * FRAME_MS) as usize;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct VadConfig {
    pub threshold: f32,
    /// So a cough or a click does not start an utterance.
    pub start_ms: u32,
    pub end_silence_ms: u32,
    /// A longer utterance is cut and passed on in parts, so a monologue is not held back. Speech going on past the cut
    /// starts the next part as any utterance starts.
    pub max_ms: u32,
    /// So the first syllable is not lost.
    pub pre_roll_ms: u32,
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            threshold: 0.5,
            start_ms: 208,
            end_silence_ms: 1400,
            max_ms: 30_000,
            pre_roll_ms: 300,
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum Cut {
    SpeechStarted,
    Utterance(Vec<i16>),
}

/// Pure, so it is tested without a VAD.
pub struct Segmenter {
    config: VadConfig,
    recent: VecDeque<Vec<i16>>,
    voiced_run_ms: u32,
    open: Option<Open>,
}

struct Open {
    samples: Vec<i16>,
    silence_run_ms: u32,
}

impl Segmenter {
    pub fn new(config: VadConfig) -> Self {
        Self {
            config,
            recent: VecDeque::new(),
            voiced_run_ms: 0,
            open: None,
        }
    }

    /// Whatever was heard so far is dropped, the start of an utterance too.
    pub fn deafen(&mut self) {
        *self = Self::new(self.config);
    }

    pub fn push(&mut self, frame: &[i16], speech: bool) -> Option<Cut> {
        let config = self.config;
        let Some(open) = &mut self.open else {
            self.recent.push_back(frame.to_vec());
            self.voiced_run_ms = if speech {
                self.voiced_run_ms + FRAME_MS
            } else {
                0
            };
            let keep = ((config.pre_roll_ms + config.start_ms) / FRAME_MS).max(1) as usize;
            while self.recent.len() > keep {
                self.recent.pop_front();
            }
            if self.voiced_run_ms < config.start_ms.max(FRAME_MS) {
                return None;
            }
            let samples: Vec<i16> = self.recent.drain(..).flatten().collect();
            self.open = Some(Open {
                samples,
                silence_run_ms: 0,
            });
            self.voiced_run_ms = 0;
            return Some(Cut::SpeechStarted);
        };
        open.samples.extend_from_slice(frame);
        open.silence_run_ms = if speech {
            0
        } else {
            open.silence_run_ms + FRAME_MS
        };
        let too_long =
            open.samples.len() as u64 * 1000 >= u64::from(config.max_ms) * u64::from(VAD_RATE);
        if open.silence_run_ms < config.end_silence_ms && !too_long {
            return None;
        }
        self.open.take().map(|open| Cut::Utterance(open.samples))
    }
}

/// Low-pass below the new Nyquist frequency before taking every third sample, against aliasing. Keeps its history
/// across calls, so a stream can be fed in pieces of any size.
pub struct Decimator {
    taps: Vec<f32>,
    history: VecDeque<f32>,
    phase: usize,
}

impl Decimator {
    pub fn new() -> Self {
        const LEN: usize = 63;
        let cutoff = 7_200.0 / SAMPLE_RATE as f32;
        let middle = (LEN - 1) as f32 / 2.0;
        let mut taps: Vec<f32> = (0..LEN)
            .map(|n| {
                let x = n as f32 - middle;
                let sinc = if x == 0.0 {
                    2.0 * cutoff
                } else {
                    (2.0 * std::f32::consts::PI * cutoff * x).sin() / (std::f32::consts::PI * x)
                };
                let window =
                    0.54 - 0.46 * (2.0 * std::f32::consts::PI * n as f32 / (LEN - 1) as f32).cos();
                sinc * window
            })
            .collect();
        let sum: f32 = taps.iter().sum();
        taps.iter_mut().for_each(|tap| *tap /= sum);
        Self {
            history: VecDeque::from(vec![0.0; LEN]),
            taps,
            phase: 0,
        }
    }

    pub fn push(&mut self, samples: &[i16]) -> Vec<i16> {
        let mut out = Vec::with_capacity(samples.len() / 3 + 1);
        for &sample in samples {
            self.history.pop_front();
            self.history.push_back(f32::from(sample));
            self.phase = (self.phase + 1) % 3;
            if self.phase == 0 {
                let value: f32 = self
                    .history
                    .iter()
                    .zip(&self.taps)
                    .map(|(x, tap)| x * tap)
                    .sum();
                out.push(
                    value
                        .round()
                        .clamp(f32::from(i16::MIN), f32::from(i16::MAX)) as i16,
                );
            }
        }
        out
    }
}

pub struct Cutter<D> {
    decimator: Decimator,
    pending: Vec<i16>,
    is_speech: D,
    segmenter: Segmenter,
}

impl<D: FnMut(&[i16]) -> bool> Cutter<D> {
    pub fn new(config: VadConfig, is_speech: D) -> Self {
        Self {
            decimator: Decimator::new(),
            pending: Vec::with_capacity(FRAME_SAMPLES * 2),
            is_speech,
            segmenter: Segmenter::new(config),
        }
    }

    /// While `deaf` (the bot is talking), nothing is cut: its own voice and the chime come back through the listener's
    /// microphone, and the two take turns.
    pub fn push(&mut self, samples: &[i16], deaf: bool) -> Vec<Cut> {
        if deaf {
            self.pending.clear();
            self.segmenter.deafen();
            return Vec::new();
        }
        self.pending.extend(self.decimator.push(samples));
        let mut cuts = Vec::new();
        while self.pending.len() >= FRAME_SAMPLES {
            let frame = &self.pending[..FRAME_SAMPLES];
            let speech = (self.is_speech)(frame);
            cuts.extend(self.segmenter.push(frame, speech));
            self.pending.drain(..FRAME_SAMPLES);
        }
        cuts
    }
}

pub fn write_wav(path: &Path, samples: &[i16], sample_rate: u32) -> Result<()> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + samples.len() * 2);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    std::fs::write(path, out).with_context(|| format!("writing {}", path.display()))
}

pub fn read_wav(bytes: &[u8]) -> Result<(Vec<i16>, u32)> {
    anyhow::ensure!(
        bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE",
        "not a WAV file"
    );
    let u16_at = |i: usize| u16::from_le_bytes([bytes[i], bytes[i + 1]]);
    let u32_at =
        |i: usize| u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
    let (mut channels, mut rate, mut bits) = (1usize, 0u32, 0u16);
    let mut offset = 12;
    while offset + 8 <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let size = u32_at(offset + 4) as usize;
        let start = offset + 8;
        if id == b"fmt " && start + 16 <= bytes.len() {
            channels = usize::from(u16_at(start + 2)).max(1);
            rate = u32_at(start + 4);
            bits = u16_at(start + 14);
        } else if id == b"data" {
            anyhow::ensure!(
                bits == 16 && rate > 0,
                "unsupported WAV: {bits} bits at {rate} Hz"
            );
            let end = (start + size).min(bytes.len());
            let frames = (end - start) / (2 * channels);
            let samples = (0..frames)
                .map(|i| {
                    i16::from_le_bytes([
                        bytes[start + i * 2 * channels],
                        bytes[start + i * 2 * channels + 1],
                    ])
                })
                .collect();
            return Ok((samples, rate));
        }
        offset = start + size + (size % 2);
    }
    anyhow::bail!("the WAV file has no data")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> VadConfig {
        VadConfig {
            threshold: 0.5,
            start_ms: 48,
            end_silence_ms: 160,
            max_ms: 1_600,
            pre_roll_ms: 32,
        }
    }

    fn feed(segmenter: &mut Segmenter, pattern: &str) -> Vec<Cut> {
        // The frame's samples carry its index, to check the cut.
        let mut cuts = Vec::new();
        for (i, c) in pattern.chars().enumerate() {
            let frame = vec![i as i16; FRAME_SAMPLES];
            if c == 'x' {
                segmenter.deafen();
            } else {
                cuts.extend(segmenter.push(&frame, c == 's'));
            }
        }
        cuts
    }

    fn frames_of(cut: &Cut) -> Vec<i16> {
        let Cut::Utterance(samples) = cut else {
            panic!("not an utterance: {cut:?}")
        };
        samples
            .chunks(FRAME_SAMPLES)
            .map(|chunk| chunk[0])
            .collect()
    }

    #[test]
    fn an_utterance_keeps_its_pre_roll_and_ends_after_the_silence() {
        let mut segmenter = Segmenter::new(config());
        let cuts = feed(&mut segmenter, "....ssssss..........");
        assert_eq!(cuts.len(), 2);
        assert_eq!(cuts[0], Cut::SpeechStarted);
        // Two frames of pre-roll (2, 3), the speech (4..10), then ten frames of silence until 160 ms of it (10..20).
        assert_eq!(frames_of(&cuts[1]), (2..20).collect::<Vec<i16>>());
    }

    #[test]
    fn bursts_shorter_than_the_start_are_no_utterance() {
        let mut segmenter = Segmenter::new(config());
        // Two frames of speech are under `start_ms`.
        assert!(feed(&mut segmenter, "ss..ss..ss..........").is_empty());
    }

    #[test]
    fn a_pause_shorter_than_the_end_silence_keeps_one_utterance() {
        let mut segmenter = Segmenter::new(config());
        let cuts = feed(&mut segmenter, "sssss.....sssss..........");
        assert_eq!(cuts.len(), 2);
        assert_eq!(frames_of(&cuts[1]).len(), 25);
    }

    #[test]
    fn deafened_mid_utterance_it_is_dropped_and_what_follows_starts_afresh() {
        let mut segmenter = Segmenter::new(config());
        let cuts = feed(&mut segmenter, "..ssssssxxxxssssss..........");
        assert_eq!(cuts.len(), 3);
        assert_eq!(cuts[0], Cut::SpeechStarted);
        assert_eq!(cuts[1], Cut::SpeechStarted);
        // No pre-roll from before the deafness.
        assert_eq!(frames_of(&cuts[2]), (12..28).collect::<Vec<i16>>());
    }

    #[test]
    fn a_long_utterance_is_passed_on_in_parts() {
        let mut segmenter = Segmenter::new(config());
        // max 1.6 s = 100 frames.
        let cuts = feed(
            &mut segmenter,
            &format!("{}{}", "s".repeat(150), ".".repeat(10)),
        );
        assert_eq!(cuts.len(), 4);
        assert_eq!(cuts[2], Cut::SpeechStarted);
        assert_eq!(frames_of(&cuts[1]), (0..100).collect::<Vec<i16>>());
        // Nothing is lost between the parts.
        assert_eq!(frames_of(&cuts[3]), (100..160).collect::<Vec<i16>>());
    }

    #[test]
    fn decimation_keeps_speech_and_drops_what_16_khz_cannot_hold() {
        let tone = |hz: f32| -> Vec<i16> {
            (0..48_000)
                .map(|i| {
                    ((2.0 * std::f32::consts::PI * hz * i as f32 / 48_000.0).sin() * 10_000.0)
                        as i16
                })
                .collect()
        };
        let peak = |samples: &[i16]| {
            samples[100..]
                .iter()
                .map(|s| s.unsigned_abs())
                .max()
                .unwrap()
        };
        let low = Decimator::new().push(&tone(1_000.0));
        assert_eq!(low.len(), 16_000);
        assert!(
            (9_000..=10_100).contains(&peak(&low)),
            "1 kHz kept: {}",
            peak(&low)
        );
        // 12 kHz would fold back to 4 kHz without the filter.
        let high = Decimator::new().push(&tone(12_000.0));
        assert!(peak(&high) < 300, "12 kHz removed: {}", peak(&high));
    }

    #[test]
    fn a_stream_in_pieces_of_any_size_is_cut_where_the_speech_is() {
        let silence = |ms: usize| vec![0i16; ms * 48];
        let tone = (0..400 * 48).map(|i| {
            ((2.0 * std::f32::consts::PI * 1_000.0 * i as f32 / 48_000.0).sin() * 10_000.0) as i16
        });
        let stream: Vec<i16> = silence(200)
            .into_iter()
            .chain(tone)
            .chain(silence(500))
            .collect();
        let mut cutter = Cutter::new(config(), |frame: &[i16]| {
            frame.iter().any(|s| s.unsigned_abs() > 5_000)
        });
        // Uneven pieces, as a network delivers them.
        let cuts: Vec<Cut> = stream
            .chunks(487)
            .flat_map(|piece| cutter.push(piece, false))
            .collect();

        assert_eq!(cuts.len(), 2);
        assert_eq!(cuts[0], Cut::SpeechStarted);
        let Cut::Utterance(utterance) = &cuts[1] else {
            panic!("not an utterance: {:?}", cuts[1])
        };
        // The tone, with up to the pre-roll before it and the ending silence after it, at 16 kHz.
        let ms = utterance.len() * 1000 / VAD_RATE as usize;
        assert!(
            (400 + 160..=400 + 160 + 32 + 2 * FRAME_MS as usize).contains(&ms),
            "{ms} ms"
        );
        assert!(
            utterance.iter().any(|s| s.unsigned_abs() > 5_000),
            "the speech is in it"
        );
    }

    #[test]
    fn wav_round_trips() {
        let dir = std::env::temp_dir().join(format!("gateway-wav-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.wav");
        write_wav(&path, &[0, 1, -1, i16::MAX, i16::MIN], 48_000).unwrap();
        let (samples, rate) = read_wav(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            (samples, rate),
            (vec![0, 1, -1, i16::MAX, i16::MIN], 48_000)
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    mod property_tests {
        use super::*;
        use proptest::prelude::*;

        #[derive(Debug, Clone, Copy)]
        enum Step {
            Speech,
            Silence,
            Deafen,
        }

        fn step_strategy() -> impl Strategy<Value = Step> {
            prop_oneof![
                4 => Just(Step::Speech),
                4 => Just(Step::Silence),
                1 => Just(Step::Deafen),
            ]
        }

        fn vad_config_strategy() -> impl Strategy<Value = VadConfig> {
            (1u32..=12, 1u32..=20, 10u32..=80, 0u32..=10).prop_map(|(start, end, max, pre)| {
                VadConfig {
                    threshold: 0.5,
                    start_ms: start * FRAME_MS,
                    end_silence_ms: end * FRAME_MS,
                    max_ms: max * FRAME_MS,
                    pre_roll_ms: pre * FRAME_MS,
                }
            })
        }

        proptest! {
            #[test]
            fn decimator_and_cutter_are_independent_of_chunk_boundaries(
                samples in prop::collection::vec(any::<i16>(), 0..4_800),
                chunk_sizes in prop::collection::vec(1usize..=600, 1..40),
            ) {
                let mut whole_dec = Decimator::new();
                let expected_dec = whole_dec.push(&samples);

                let mut chunked_dec = Decimator::new();
                let mut actual_dec = Vec::new();
                let mut pos = 0;
                let mut idx = 0;
                while pos < samples.len() {
                    let size = chunk_sizes[idx % chunk_sizes.len()];
                    let end = (pos + size).min(samples.len());
                    actual_dec.extend(chunked_dec.push(&samples[pos..end]));
                    pos = end;
                    idx += 1;
                }
                prop_assert_eq!(actual_dec, expected_dec);

                let detector = |frame: &[i16]| frame.iter().any(|s| s.unsigned_abs() > 10_000);
                let mut whole_cut = Cutter::new(config(), detector);
                let expected_cuts = whole_cut.push(&samples, false);

                let mut chunked_cut = Cutter::new(config(), detector);
                let mut actual_cuts = Vec::new();
                pos = 0;
                idx = 0;
                while pos < samples.len() {
                    let size = chunk_sizes[idx % chunk_sizes.len()];
                    let end = (pos + size).min(samples.len());
                    actual_cuts.extend(chunked_cut.push(&samples[pos..end], false));
                    pos = end;
                    idx += 1;
                }
                prop_assert_eq!(actual_cuts, expected_cuts);
            }

            #[test]
            fn segmenter_preserves_state_machine_and_length_invariants(
                cfg in vad_config_strategy(),
                steps in prop::collection::vec(step_strategy(), 1..200),
            ) {
                let mut segmenter = Segmenter::new(cfg);
                let mut open = false;
                let mut last_deafen: Option<usize> = None;
                let pre_and_start = ((cfg.pre_roll_ms + cfg.start_ms) / FRAME_MS).max(1) as usize;
                let max_frames = (cfg.max_ms as usize).div_ceil(FRAME_MS as usize).max(pre_and_start + 1);

                for (i, step) in steps.into_iter().enumerate() {
                    match step {
                        Step::Deafen => {
                            segmenter.deafen();
                            open = false;
                            last_deafen = Some(i);
                        }
                        Step::Speech | Step::Silence => {
                            let frame = vec![i as i16; FRAME_SAMPLES];
                            if let Some(cut) = segmenter.push(&frame, matches!(step, Step::Speech)) {
                                match cut {
                                    Cut::SpeechStarted => {
                                        prop_assert!(!open);
                                        open = true;
                                    }
                                    Cut::Utterance(samples) => {
                                        prop_assert!(open);
                                        open = false;
                                        prop_assert!(!samples.is_empty());
                                        prop_assert_eq!(samples.len() % FRAME_SAMPLES, 0);
                                        let frames = samples.len() / FRAME_SAMPLES;
                                        prop_assert!(frames <= max_frames, "frames={frames} > max_frames={max_frames}");
                                        if let Some(d) = last_deafen {
                                            for chunk in samples.chunks(FRAME_SAMPLES) {
                                                prop_assert!((chunk[0] as usize) > d);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            #[test]
            fn cutter_emits_nothing_while_deaf(
                chunks in prop::collection::vec((prop::collection::vec(any::<i16>(), 0..600), any::<bool>()), 1..40),
            ) {
                let mut cutter = Cutter::new(config(), |frame: &[i16]| frame.iter().any(|s| s.unsigned_abs() > 5_000));
                for (chunk, deaf) in chunks {
                    let cuts = cutter.push(&chunk, deaf);
                    if deaf {
                        prop_assert!(cuts.is_empty());
                    }
                }
            }

            #[test]
            fn wav_round_trips_any_samples(
                samples in prop::collection::vec(any::<i16>(), 0..512),
                rate in prop_oneof![Just(16_000u32), Just(48_000u32)],
            ) {
                let path = std::env::temp_dir().join(format!("gateway-wav-prop-{}.wav", std::process::id()));
                write_wav(&path, &samples, rate).unwrap();
                let bytes = std::fs::read(&path).unwrap();
                let _ = std::fs::remove_file(&path);
                let (decoded, decoded_rate) = read_wav(&bytes).unwrap();
                prop_assert_eq!((decoded, decoded_rate), (samples, rate));
            }
        }
    }
}
