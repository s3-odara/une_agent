//! Audio of calls: cutting a participant's stream into utterances, and WAV files in and out.

use std::collections::VecDeque;
use std::path::Path;

use anyhow::{Context, Result};
use serde::Deserialize;

/// Call audio is 48 kHz mono 16-bit, as LiveKit hands it over and takes it.
pub const SAMPLE_RATE: u32 = 48_000;
/// What the VAD (and the speech recognizer) work at: a third of the call's rate.
pub const VAD_RATE: u32 = 16_000;
/// The VAD judges 16 ms at a time.
pub const FRAME_MS: u32 = 16;
pub const FRAME_SAMPLES: usize = (VAD_RATE / 1000 * FRAME_MS) as usize;

/// How a stream is cut into utterances. The agent sends it with the join, from `config.json`.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[cfg_attr(test, derive(serde::Serialize))]
#[serde(rename_all = "camelCase")]
pub struct VadConfig {
    /// The VAD's score (0 to 1) from which a frame counts as speech.
    pub threshold: f32,
    /// Speech must go on this long before it counts: a cough or a click does not start an utterance, or stop the bot.
    pub start_ms: u32,
    /// This much silence ends an utterance.
    pub end_silence_ms: u32,
    /// Utterances with less speech than this are dropped.
    pub min_speech_ms: u32,
    /// A longer utterance is cut and passed on in parts, so a monologue is not held back.
    pub max_ms: u32,
    /// Audio kept from before the start, so the first syllable is not lost.
    pub pre_roll_ms: u32,
}

#[derive(Debug, PartialEq)]
pub enum Cut {
    /// Somebody started speaking (after `start_ms` of speech).
    SpeechStarted,
    /// One utterance, pre-roll included.
    Utterance(Vec<i16>),
}

/// Turns 16 ms frames, each judged speech or not, into utterances. Pure, so it is tested without a VAD.
pub struct Segmenter {
    config: VadConfig,
    /// Recent frames while nobody speaks: the pre-roll, plus the speech that has not yet lasted `start_ms`.
    recent: VecDeque<Vec<i16>>,
    /// Consecutive speech frames while idle.
    voiced_run: u32,
    /// Some while an utterance is open.
    open: Option<Open>,
}

struct Open {
    samples: Vec<i16>,
    speech_ms: u32,
    silence_run_ms: u32,
}

impl Segmenter {
    pub fn new(config: VadConfig) -> Self {
        Self { config, recent: VecDeque::new(), voiced_run: 0, open: None }
    }

    pub fn push(&mut self, frame: &[i16], speech: bool) -> Option<Cut> {
        let config = self.config;
        let Some(open) = &mut self.open else {
            self.recent.push_back(frame.to_vec());
            self.voiced_run = if speech { self.voiced_run + 1 } else { 0 };
            let keep = ((config.pre_roll_ms + config.start_ms) / FRAME_MS).max(1) as usize;
            while self.recent.len() > keep {
                self.recent.pop_front();
            }
            if self.voiced_run * FRAME_MS < config.start_ms.max(FRAME_MS) {
                return None;
            }
            let samples: Vec<i16> = self.recent.drain(..).flatten().collect();
            self.open = Some(Open { samples, speech_ms: self.voiced_run * FRAME_MS, silence_run_ms: 0 });
            self.voiced_run = 0;
            return Some(Cut::SpeechStarted);
        };
        open.samples.extend_from_slice(frame);
        if speech {
            open.speech_ms += FRAME_MS;
            open.silence_run_ms = 0;
        } else {
            open.silence_run_ms += FRAME_MS;
        }
        let too_long = open.samples.len() as u64 * 1000 >= u64::from(config.max_ms) * u64::from(VAD_RATE);
        if open.silence_run_ms < config.end_silence_ms && !too_long {
            return None;
        }
        let open = self.open.take().expect("an open utterance");
        if too_long && open.silence_run_ms < config.end_silence_ms {
            // Still speaking: the rest goes on as a new utterance at once.
            self.open = Some(Open { samples: Vec::new(), speech_ms: 0, silence_run_ms: 0 });
        }
        (open.speech_ms >= config.min_speech_ms).then_some(Cut::Utterance(open.samples))
    }
}

/// 48 kHz to 16 kHz: a low-pass filter below the new Nyquist frequency, then every third sample. Keeps its history
/// across calls, so a stream can be fed in pieces of any size.
pub struct Decimator {
    taps: Vec<f32>,
    history: VecDeque<f32>,
    phase: usize,
}

impl Decimator {
    pub fn new() -> Self {
        // Windowed sinc, cut off at 7.2 kHz, Hamming window.
        const LEN: usize = 63;
        let cutoff = 7_200.0 / SAMPLE_RATE as f32;
        let middle = (LEN - 1) as f32 / 2.0;
        let mut taps: Vec<f32> = (0..LEN)
            .map(|n| {
                let x = n as f32 - middle;
                let sinc = if x == 0.0 { 2.0 * cutoff } else { (2.0 * std::f32::consts::PI * cutoff * x).sin() / (std::f32::consts::PI * x) };
                let window = 0.54 - 0.46 * (2.0 * std::f32::consts::PI * n as f32 / (LEN - 1) as f32).cos();
                sinc * window
            })
            .collect();
        let sum: f32 = taps.iter().sum();
        taps.iter_mut().for_each(|tap| *tap /= sum);
        Self { history: VecDeque::from(vec![0.0; LEN]), taps, phase: 0 }
    }

    pub fn push(&mut self, samples: &[i16]) -> Vec<i16> {
        let mut out = Vec::with_capacity(samples.len() / 3 + 1);
        for &sample in samples {
            self.history.pop_front();
            self.history.push_back(f32::from(sample));
            self.phase = (self.phase + 1) % 3;
            if self.phase == 0 {
                let value: f32 = self.history.iter().zip(&self.taps).map(|(x, tap)| x * tap).sum();
                out.push(value.round().clamp(f32::from(i16::MIN), f32::from(i16::MAX)) as i16);
            }
        }
        out
    }
}

/// A participant's 48 kHz stream in, cuts out: decimated to 16 kHz, framed, each frame judged by `is_speech`, and the
/// frames segmented. The call feeds it what LiveKit hands over, in pieces of any size.
pub struct Cutter<D> {
    decimator: Decimator,
    /// 16 kHz samples not yet making a whole frame.
    pending: Vec<i16>,
    is_speech: D,
    segmenter: Segmenter,
}

impl<D: FnMut(&[i16]) -> bool> Cutter<D> {
    pub fn new(config: VadConfig, is_speech: D) -> Self {
        Self { decimator: Decimator::new(), pending: Vec::with_capacity(FRAME_SAMPLES * 2), is_speech, segmenter: Segmenter::new(config) }
    }

    pub fn push(&mut self, samples: &[i16]) -> Vec<Cut> {
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

/// Writes mono 16-bit PCM as a WAV file.
pub fn write_wav(path: &Path, samples: &[i16], sample_rate: u32) -> Result<()> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + samples.len() * 2);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
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

/// Reads a 16-bit PCM WAV file: the first channel and its sample rate.
pub fn read_wav(bytes: &[u8]) -> Result<(Vec<i16>, u32)> {
    anyhow::ensure!(bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE", "not a WAV file");
    let u16_at = |i: usize| u16::from_le_bytes([bytes[i], bytes[i + 1]]);
    let u32_at = |i: usize| u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
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
            anyhow::ensure!(bits == 16 && rate > 0, "unsupported WAV: {bits} bits at {rate} Hz");
            let end = (start + size).min(bytes.len());
            let frames = (end - start) / (2 * channels);
            let samples = (0..frames).map(|i| i16::from_le_bytes([bytes[start + i * 2 * channels], bytes[start + i * 2 * channels + 1]])).collect();
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
        VadConfig { threshold: 0.5, start_ms: 48, end_silence_ms: 160, min_speech_ms: 80, max_ms: 1_600, pre_roll_ms: 32 }
    }

    fn feed(segmenter: &mut Segmenter, pattern: &str) -> Vec<Cut> {
        // Each character is one frame: `s` speech, `.` silence. The frame's samples carry its index, to check the cut.
        let mut cuts = Vec::new();
        for (i, c) in pattern.chars().enumerate() {
            let frame = vec![i as i16; FRAME_SAMPLES];
            cuts.extend(segmenter.push(&frame, c == 's'));
        }
        cuts
    }

    fn frames_of(cut: &Cut) -> Vec<i16> {
        let Cut::Utterance(samples) = cut else { panic!("not an utterance: {cut:?}") };
        samples.chunks(FRAME_SAMPLES).map(|chunk| chunk[0]).collect()
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
    fn short_bursts_neither_start_nor_count() {
        let mut segmenter = Segmenter::new(config());
        // Two frames of speech are under `start_ms`.
        assert!(feed(&mut segmenter, "ss..ss..ss..").is_empty());
        // Started, but only 64 ms of speech: under `min_speech_ms`, so dropped at the end.
        let mut segmenter = Segmenter::new(config());
        let cuts = feed(&mut segmenter, "ssss..........");
        assert_eq!(cuts, vec![Cut::SpeechStarted]);
    }

    #[test]
    fn a_pause_shorter_than_the_end_silence_keeps_one_utterance() {
        let mut segmenter = Segmenter::new(config());
        let cuts = feed(&mut segmenter, "sssss.....sssss..........");
        assert_eq!(cuts.len(), 2);
        assert_eq!(frames_of(&cuts[1]).len(), 25);
    }

    #[test]
    fn a_long_utterance_is_passed_on_in_parts() {
        let mut segmenter = Segmenter::new(config());
        // max 1.6 s = 100 frames.
        let cuts = feed(&mut segmenter, &format!("{}{}", "s".repeat(150), ".".repeat(10)));
        assert_eq!(cuts.len(), 3);
        assert_eq!(frames_of(&cuts[1]).len(), 100);
        assert_eq!(frames_of(&cuts[2]).len(), 150 + 10 - 100);
    }

    #[test]
    fn decimation_keeps_speech_and_drops_what_16_khz_cannot_hold() {
        let tone = |hz: f32| -> Vec<i16> { (0..48_000).map(|i| ((2.0 * std::f32::consts::PI * hz * i as f32 / 48_000.0).sin() * 10_000.0) as i16).collect() };
        let peak = |samples: &[i16]| samples[100..].iter().map(|s| s.unsigned_abs()).max().unwrap();
        let low = Decimator::new().push(&tone(1_000.0));
        assert_eq!(low.len(), 16_000);
        assert!((9_000..=10_100).contains(&peak(&low)), "1 kHz kept: {}", peak(&low));
        // 12 kHz would fold back to 4 kHz without the filter.
        let high = Decimator::new().push(&tone(12_000.0));
        assert!(peak(&high) < 300, "12 kHz removed: {}", peak(&high));
    }

    #[test]
    fn a_stream_in_pieces_of_any_size_is_cut_where_the_speech_is() {
        // 48 kHz: 0.2 s of silence, 0.4 s of a 1 kHz tone, then 0.5 s of silence; the tone is what counts as speech.
        let silence = |ms: usize| vec![0i16; ms * 48];
        let tone = (0..400 * 48).map(|i| ((2.0 * std::f32::consts::PI * 1_000.0 * i as f32 / 48_000.0).sin() * 10_000.0) as i16);
        let stream: Vec<i16> = silence(200).into_iter().chain(tone).chain(silence(500)).collect();
        let mut cutter = Cutter::new(config(), |frame: &[i16]| frame.iter().any(|s| s.unsigned_abs() > 5_000));
        // Uneven pieces, as a network delivers them.
        let cuts: Vec<Cut> = stream.chunks(487).flat_map(|piece| cutter.push(piece)).collect();

        assert_eq!(cuts.len(), 2);
        assert_eq!(cuts[0], Cut::SpeechStarted);
        let Cut::Utterance(utterance) = &cuts[1] else { panic!("not an utterance: {:?}", cuts[1]) };
        // The tone, with up to the pre-roll before it and the ending silence after it, at 16 kHz.
        let ms = utterance.len() * 1000 / VAD_RATE as usize;
        assert!((400 + 160..=400 + 160 + 32 + 2 * FRAME_MS as usize).contains(&ms), "{ms} ms");
        assert!(utterance.iter().any(|s| s.unsigned_abs() > 5_000), "the speech is in it");
    }

    #[test]
    fn wav_round_trips() {
        let dir = std::env::temp_dir().join(format!("gateway-wav-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.wav");
        write_wav(&path, &[0, 1, -1, i16::MAX, i16::MIN], 48_000).unwrap();
        let (samples, rate) = read_wav(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!((samples, rate), (vec![0, 1, -1, i16::MAX, i16::MIN], 48_000));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
