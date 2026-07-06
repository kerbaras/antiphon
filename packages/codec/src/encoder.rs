//! Streaming FLAC encoder + chunker (RFC §6.2–6.3).
//!
//! One `StreamEncoder` per take. PCM goes in (any slab size), encoded chunks
//! come out, each an integral number of FLAC frames — a FLAC frame never
//! spans chunks, so sink-side reconstruction is exact concatenation:
//! `codec_header()` bytes followed by every chunk payload in seq order is a
//! valid, decodable `.flac` stream.
//!
//! Chunking policy: flush at ~`NOMINAL_CHUNK_MS` of audio, or earlier if the
//! next frame would push the payload past the frame-size bound (§6.3).

use antiphon_core::constants::{MAX_CHUNK_PAYLOAD_BYTES, NOMINAL_CHUNK_MS};
use flacenc::bitsink::ByteSink;
use flacenc::component::BitRepr;
use flacenc::error::{Verified, Verify};
use flacenc::source::{Fill, FrameBuf};

/// FLAC block size in samples. 4096 is the format's canonical choice; at
/// 48 kHz one block is ~85 ms and six blocks make one nominal chunk.
pub const BLOCK_SIZE: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EncoderConfig {
    pub sample_rate: u32,
    /// 16 or 24 (RFC §13).
    pub bits_per_sample: u8,
}

impl EncoderConfig {
    fn validate(&self) -> Result<(), CodecError> {
        if !matches!(self.bits_per_sample, 16 | 24) {
            return Err(CodecError::UnsupportedBitDepth(self.bits_per_sample));
        }
        if self.sample_rate == 0 || self.sample_rate >= (1 << 20) {
            return Err(CodecError::UnsupportedSampleRate(self.sample_rate));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CodecError {
    #[error("unsupported bit depth {0} (16 or 24)")]
    UnsupportedBitDepth(u8),
    #[error("unsupported sample rate {0}")]
    UnsupportedSampleRate(u32),
    #[error("flac configuration rejected: {0}")]
    Config(String),
    #[error("flac encode failed: {0}")]
    Encode(String),
    #[error("encoded frame exceeds chunk payload bound ({0} bytes)")]
    FrameTooLarge(usize),
    #[error("encoder already finished")]
    Finished,
}

/// One protocol chunk's worth of encoded audio.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodedChunk {
    /// Whole FLAC frames.
    pub payload: Vec<u8>,
    /// Absolute index of the first sample in the take's sample domain.
    pub first_sample_index: u64,
    pub sample_count: u32,
}

pub struct StreamEncoder {
    config: Verified<flacenc::config::Encoder>,
    /// Verbatim-only escape hatch: flacenc's rice-parameter selection can
    /// degenerate on pathological content (observed: a 4080-sample 24-bit
    /// square wave encoding to ~100 MB through flacenc's own reference
    /// path). A FLAC frame must fit one chunk (§6.3), so any block whose
    /// frame exceeds the payload bound is re-encoded verbatim — bounded at
    /// raw size (~12 KB/block), still perfectly lossless.
    fallback_config: Verified<flacenc::config::Encoder>,
    stream_info: flacenc::component::StreamInfo,
    /// Reused per block; partially filled for the final short frame (the
    /// encoder keys the frame's block size off `filled_size`).
    framebuf: FrameBuf,
    cfg: EncoderConfig,
    /// Samples awaiting a full block.
    pending: Vec<i32>,
    next_frame_number: usize,
    /// Total samples consumed from the caller.
    samples_in: u64,
    /// Total samples already encoded into emitted FLAC frames — the take
    /// sample-domain cursor for chunk boundaries.
    encoded_cursor: u64,
    /// Current chunk under construction.
    chunk_payload: Vec<u8>,
    chunk_first_sample: u64,
    chunk_samples: u32,
    nominal_chunk_samples: u64,
    finished: bool,
}

impl StreamEncoder {
    pub fn new(cfg: EncoderConfig) -> Result<Self, CodecError> {
        cfg.validate()?;
        let mut enc = flacenc::config::Encoder::default();
        enc.block_size = BLOCK_SIZE;
        enc.multithread = false;
        let config = enc
            .into_verified()
            .map_err(|(_, e)| CodecError::Config(e.to_string()))?;
        let mut fallback = flacenc::config::Encoder::default();
        fallback.block_size = BLOCK_SIZE;
        fallback.multithread = false;
        fallback.subframe_coding.use_constant = false;
        fallback.subframe_coding.use_fixed = false;
        fallback.subframe_coding.use_lpc = false;
        let fallback_config = fallback
            .into_verified()
            .map_err(|(_, e)| CodecError::Config(e.to_string()))?;
        let stream_info = flacenc::component::StreamInfo::new(
            cfg.sample_rate as usize,
            1,
            cfg.bits_per_sample as usize,
        )
        .map_err(|e| CodecError::Config(e.to_string()))?;
        let framebuf =
            FrameBuf::with_size(1, BLOCK_SIZE).map_err(|e| CodecError::Config(e.to_string()))?;
        Ok(Self {
            config,
            fallback_config,
            stream_info,
            framebuf,
            cfg,
            pending: Vec::with_capacity(BLOCK_SIZE),
            next_frame_number: 0,
            samples_in: 0,
            encoded_cursor: 0,
            chunk_payload: Vec::new(),
            chunk_first_sample: 0,
            chunk_samples: 0,
            nominal_chunk_samples: u64::from(cfg.sample_rate) * u64::from(NOMINAL_CHUNK_MS) / 1_000,
            finished: false,
        })
    }

    pub fn config(&self) -> EncoderConfig {
        self.cfg
    }

    /// Samples consumed so far (the take sample-domain cursor).
    pub fn samples_in(&self) -> u64 {
        self.samples_in
    }

    /// `fLaC` marker + STREAMINFO metadata block (last-block flag set): the
    /// codec bootstrap carried in the seq-0 stream header payload.
    ///
    /// Hand-assembled rather than borrowed from flacenc because a streaming
    /// encoder emits this before any frame exists: frame-size fields use the
    /// spec's 0 = unknown convention, total-samples and MD5 are unknown, and
    /// both block-size fields are `BLOCK_SIZE` (a fixed-block-size stream —
    /// the final short block is exempt per the FLAC spec).
    pub fn codec_header(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(4 + 4 + 34);
        out.extend_from_slice(b"fLaC");
        out.extend_from_slice(&[0x80, 0x00, 0x00, 0x22]); // last, type 0, len 34
        let block = BLOCK_SIZE as u16;
        out.extend_from_slice(&block.to_be_bytes()); // min block size
        out.extend_from_slice(&block.to_be_bytes()); // max block size
        out.extend_from_slice(&[0, 0, 0]); // min frame size: unknown
        out.extend_from_slice(&[0, 0, 0]); // max frame size: unknown
        let rate = self.cfg.sample_rate;
        let channels_m1 = 0u32; // mono
        let bps_m1 = u32::from(self.cfg.bits_per_sample) - 1;
        out.push((rate >> 12) as u8);
        out.push((rate >> 4) as u8);
        out.push((((rate & 0xF) << 4) | (channels_m1 << 1) | (bps_m1 >> 4)) as u8);
        out.push(((bps_m1 & 0xF) << 4) as u8); // + total_samples top 4 bits = 0
        out.extend_from_slice(&[0, 0, 0, 0]); // total samples: unknown
        out.extend_from_slice(&[0u8; 16]); // md5: unknown
        debug_assert_eq!(out.len(), 42);
        out
    }

    /// Push float samples in `[-1.0, 1.0]` (the Web Audio native format).
    pub fn push_f32(&mut self, samples: &[f32]) -> Result<Vec<EncodedChunk>, CodecError> {
        let scale = f64::from(1u32 << (self.cfg.bits_per_sample - 1));
        let max = (1i64 << (self.cfg.bits_per_sample - 1)) - 1;
        let min = -(1i64 << (self.cfg.bits_per_sample - 1));
        let ints: Vec<i32> = samples
            .iter()
            .map(|&f| ((f64::from(f) * scale).round() as i64).clamp(min, max) as i32)
            .collect();
        self.push_i32(&ints)
    }

    /// Push integer samples already in the configured bit depth's range.
    pub fn push_i32(&mut self, samples: &[i32]) -> Result<Vec<EncodedChunk>, CodecError> {
        if self.finished {
            return Err(CodecError::Finished);
        }
        self.samples_in += samples.len() as u64;
        let mut out = Vec::new();
        let mut rest = samples;
        while !rest.is_empty() {
            let need = BLOCK_SIZE - self.pending.len();
            let take = need.min(rest.len());
            self.pending.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
            if self.pending.len() == BLOCK_SIZE {
                self.encode_pending_block(&mut out)?;
            }
        }
        Ok(out)
    }

    /// Final flush: encodes the trailing partial block (if any) and emits the
    /// final — possibly short — chunk (§6.3 exempts the final chunk from the
    /// minimum duration).
    pub fn finish(&mut self) -> Result<Vec<EncodedChunk>, CodecError> {
        if self.finished {
            return Err(CodecError::Finished);
        }
        self.finished = true;
        let mut out = Vec::new();
        if !self.pending.is_empty() {
            let samples = std::mem::take(&mut self.pending);
            let bytes = self.encode_block(&samples)?;
            self.append_frame(&bytes, samples.len() as u32, &mut out)?;
        }
        if self.chunk_samples > 0 {
            out.push(self.take_chunk());
        }
        Ok(out)
    }

    fn encode_pending_block(&mut self, out: &mut Vec<EncodedChunk>) -> Result<(), CodecError> {
        debug_assert_eq!(self.pending.len(), BLOCK_SIZE);
        let samples = std::mem::take(&mut self.pending);
        let bytes = self.encode_block(&samples)?;
        self.pending = Vec::with_capacity(BLOCK_SIZE);
        self.append_frame(&bytes, samples.len() as u32, out)
    }

    fn encode_block(&mut self, samples: &[i32]) -> Result<Vec<u8>, CodecError> {
        debug_assert!(samples.len() <= BLOCK_SIZE);
        self.framebuf
            .fill_interleaved(samples)
            .map_err(|e| CodecError::Encode(e.to_string()))?;
        let mut bytes = self.write_frame(&self.config)?;
        if bytes.len() > MAX_CHUNK_PAYLOAD_BYTES {
            // Degenerate compression (see `fallback_config` docs): re-encode
            // this block verbatim. Same samples, same frame number, bounded
            // at raw size, still lossless.
            bytes = self.write_frame(&self.fallback_config)?;
            if bytes.len() > MAX_CHUNK_PAYLOAD_BYTES {
                return Err(CodecError::FrameTooLarge(bytes.len()));
            }
        }
        self.next_frame_number += 1;
        Ok(bytes)
    }

    fn write_frame(
        &self,
        config: &Verified<flacenc::config::Encoder>,
    ) -> Result<Vec<u8>, CodecError> {
        let frame = flacenc::encode_fixed_size_frame(
            config,
            &self.framebuf,
            self.next_frame_number,
            &self.stream_info,
        )
        .map_err(|e| CodecError::Encode(e.to_string()))?;
        let mut sink = ByteSink::new();
        frame
            .write(&mut sink)
            .map_err(|e| CodecError::Encode(e.to_string()))?;
        Ok(sink.into_inner())
    }

    fn append_frame(
        &mut self,
        frame_bytes: &[u8],
        sample_count: u32,
        out: &mut Vec<EncodedChunk>,
    ) -> Result<(), CodecError> {
        if frame_bytes.len() > MAX_CHUNK_PAYLOAD_BYTES {
            return Err(CodecError::FrameTooLarge(frame_bytes.len()));
        }
        // Split early if this frame would overflow the payload bound (§6.3).
        if !self.chunk_payload.is_empty()
            && self.chunk_payload.len() + frame_bytes.len() > MAX_CHUNK_PAYLOAD_BYTES
        {
            out.push(self.take_chunk());
        }
        if self.chunk_payload.is_empty() {
            self.chunk_first_sample = self.encoded_cursor;
        }
        self.chunk_payload.extend_from_slice(frame_bytes);
        self.chunk_samples += sample_count;
        self.encoded_cursor += u64::from(sample_count);
        if u64::from(self.chunk_samples) >= self.nominal_chunk_samples {
            out.push(self.take_chunk());
        }
        Ok(())
    }

    fn take_chunk(&mut self) -> EncodedChunk {
        let chunk = EncodedChunk {
            payload: std::mem::take(&mut self.chunk_payload),
            first_sample_index: self.chunk_first_sample,
            sample_count: self.chunk_samples,
        };
        self.chunk_samples = 0;
        chunk
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(n: usize, rate: u32, freq: f32) -> Vec<f32> {
        (0..n)
            .map(|i| (i as f32 * freq * std::f32::consts::TAU / rate as f32).sin() * 0.8)
            .collect()
    }

    fn expected_i32(samples: &[f32], bits: u8) -> Vec<i32> {
        let scale = f64::from(1u32 << (bits - 1));
        let max = (1i64 << (bits - 1)) - 1;
        let min = -(1i64 << (bits - 1));
        samples
            .iter()
            .map(|&f| ((f64::from(f) * scale).round() as i64).clamp(min, max) as i32)
            .collect()
    }

    fn decode(bytes: &[u8]) -> (claxon::metadata::StreamInfo, Vec<i32>) {
        let mut reader =
            claxon::FlacReader::new(std::io::Cursor::new(bytes.to_vec())).expect("valid flac");
        let info = reader.streaminfo();
        let samples: Vec<i32> = reader.samples().map(|s| s.expect("sample")).collect();
        (info, samples)
    }

    fn assemble(header: &[u8], chunks: &[EncodedChunk]) -> Vec<u8> {
        let mut out = header.to_vec();
        for c in chunks {
            out.extend_from_slice(&c.payload);
        }
        out
    }

    #[test]
    fn roundtrip_sample_exact_24bit() {
        let rate = 48_000;
        let input = sine(rate as usize * 2 + 7_331, rate, 440.0);
        let mut enc = StreamEncoder::new(EncoderConfig {
            sample_rate: rate,
            bits_per_sample: 24,
        })
        .unwrap();
        let mut chunks = enc.push_f32(&input).unwrap();
        chunks.extend(enc.finish().unwrap());

        let flac = assemble(&enc.codec_header(), &chunks);
        let (info, decoded) = decode(&flac);
        assert_eq!(info.sample_rate, rate);
        assert_eq!(info.channels, 1);
        assert_eq!(info.bits_per_sample, 24);
        assert_eq!(decoded, expected_i32(&input, 24), "lossless or bust");
    }

    #[test]
    fn roundtrip_sample_exact_16bit_noise_and_silence() {
        let rate = 44_100;
        // Deterministic noise, then silence, then a click.
        let mut state = 0x8BADF00Du64;
        let mut input: Vec<f32> = (0..rate as usize)
            .map(|_| {
                state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
                (((state >> 33) as i32) as f32 / i32::MAX as f32) * 0.9
            })
            .collect();
        input.extend(std::iter::repeat_n(0.0f32, 10_000));
        input.push(1.5); // clips → clamp
        input.push(-1.5);
        let mut enc = StreamEncoder::new(EncoderConfig {
            sample_rate: rate,
            bits_per_sample: 16,
        })
        .unwrap();
        let mut chunks = enc.push_f32(&input).unwrap();
        chunks.extend(enc.finish().unwrap());
        let (info, decoded) = decode(&assemble(&enc.codec_header(), &chunks));
        assert_eq!(info.bits_per_sample, 16);
        assert_eq!(decoded, expected_i32(&input, 16));
    }

    #[test]
    fn chunk_domains_are_contiguous_and_frame_aligned() {
        let rate = 48_000;
        let input = sine(rate as usize * 3, rate, 220.0);
        let mut enc = StreamEncoder::new(EncoderConfig {
            sample_rate: rate,
            bits_per_sample: 24,
        })
        .unwrap();
        let mut chunks = Vec::new();
        // Push in awkward slab sizes to stress the block assembly.
        for slab in input.chunks(1_237) {
            chunks.extend(enc.push_f32(slab).unwrap());
        }
        chunks.extend(enc.finish().unwrap());

        assert!(
            chunks.len() >= 5,
            "3s at 500ms nominal must be several chunks"
        );
        let mut cursor = 0u64;
        for (i, c) in chunks.iter().enumerate() {
            assert_eq!(c.first_sample_index, cursor, "chunk {i} domain continuity");
            assert!(c.sample_count > 0);
            assert!(c.payload.len() <= MAX_CHUNK_PAYLOAD_BYTES);
            // Every chunk starts on a FLAC frame boundary: sync code.
            assert_eq!(c.payload[0], 0xFF, "chunk {i} sync byte");
            assert_eq!(c.payload[1] & 0xFC, 0xF8, "chunk {i} sync code");
            cursor += u64::from(c.sample_count);
        }
        assert_eq!(cursor, input.len() as u64);
        // Non-final chunks respect the nominal duration target.
        for c in &chunks[..chunks.len() - 1] {
            assert!(
                u64::from(c.sample_count) >= u64::from(rate) / 10,
                "non-final chunk under MIN_CHUNK_MS"
            );
        }
    }

    #[test]
    fn push_granularity_does_not_change_the_bitstream() {
        let rate = 48_000;
        let input = sine(rate as usize, rate, 330.0);
        let encode = |slabs: &[&[f32]]| {
            let mut enc = StreamEncoder::new(EncoderConfig {
                sample_rate: rate,
                bits_per_sample: 24,
            })
            .unwrap();
            let mut chunks = Vec::new();
            for s in slabs {
                chunks.extend(enc.push_f32(s).unwrap());
            }
            chunks.extend(enc.finish().unwrap());
            assemble(&enc.codec_header(), &chunks)
        };
        let one = encode(&[&input]);
        let many: Vec<&[f32]> = input.chunks(311).collect();
        let split = encode(&many);
        assert_eq!(one, split, "bitstream must not depend on push slab sizes");
    }

    #[test]
    fn header_parses_standalone() {
        let enc = StreamEncoder::new(EncoderConfig {
            sample_rate: 48_000,
            bits_per_sample: 24,
        })
        .unwrap();
        let (info, samples) = decode(&enc.codec_header());
        assert_eq!(info.sample_rate, 48_000);
        assert_eq!(info.bits_per_sample, 24);
        assert_eq!(info.channels, 1);
        assert!(samples.is_empty());
    }

    #[test]
    fn empty_take_yields_no_chunks() {
        let mut enc = StreamEncoder::new(EncoderConfig {
            sample_rate: 48_000,
            bits_per_sample: 24,
        })
        .unwrap();
        assert!(enc.finish().unwrap().is_empty());
        assert!(
            enc.push_i32(&[0]).is_err(),
            "finished encoder refuses input"
        );
    }
}
