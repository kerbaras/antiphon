//! NTP-style coarse clock sync over the data channel (RFC §6.7).
//!
//! Output feeds coarse chunk placement only — alignment truth is acoustic.
//! Over jittery paths the estimator MUST filter by minimum RTT across a
//! sliding window (best of the last 16 samples).

use crate::constants::TIME_SYNC_WINDOW;
use crate::frame::{TimePing, TimePong};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimeSample {
    /// Remote clock minus local clock, microseconds.
    pub offset_us: i64,
    /// Round-trip time minus remote processing time, microseconds.
    pub rtt_us: u64,
}

#[derive(Debug, Default)]
pub struct TimeSync {
    next_ping_id: u32,
    /// Outstanding pings: (ping_id, t1).
    in_flight: Vec<(u32, u64)>,
    /// Sliding window of completed samples, newest last.
    window: Vec<TimeSample>,
}

impl TimeSync {
    pub fn new() -> Self {
        Self::default()
    }

    /// Create the next ping. `now_us` is the local monotonic clock.
    pub fn ping(&mut self, now_us: u64) -> TimePing {
        let ping_id = self.next_ping_id;
        self.next_ping_id = self.next_ping_id.wrapping_add(1);
        self.in_flight.push((ping_id, now_us));
        // Unanswered pings are abandoned once enough newer ones exist.
        if self.in_flight.len() > TIME_SYNC_WINDOW {
            self.in_flight.remove(0);
        }
        TimePing {
            ping_id,
            t1: now_us,
        }
    }

    /// Responder side: answer a ping. `recv_us`/`send_us` are the responder's
    /// clock at receipt and at send.
    pub fn pong_for(ping: &TimePing, recv_us: u64, send_us: u64) -> TimePong {
        TimePong {
            ping_id: ping.ping_id,
            t1: ping.t1,
            t2: recv_us,
            t3: send_us,
        }
    }

    /// Initiator side: fold in a pong received at local time `t4_us`.
    pub fn handle_pong(&mut self, pong: &TimePong, t4_us: u64) -> Option<TimeSample> {
        let idx = self
            .in_flight
            .iter()
            .position(|&(id, _)| id == pong.ping_id)?;
        let (_, t1) = self.in_flight.remove(idx);
        // Sanity: the echoed t1 must match what we sent (tolerate equality
        // only; a mangled echo is a bogus sample).
        if pong.t1 != t1 || t4_us < t1 || pong.t3 < pong.t2 {
            return None;
        }
        let t1 = t1 as i128;
        let t2 = i128::from(pong.t2);
        let t3 = i128::from(pong.t3);
        let t4 = t4_us as i128;
        let offset = ((t2 - t1) + (t3 - t4)) / 2;
        let rtt = (t4 - t1) - (t3 - t2);
        if rtt < 0 {
            return None;
        }
        let sample = TimeSample {
            offset_us: offset as i64,
            rtt_us: rtt as u64,
        };
        self.window.push(sample);
        if self.window.len() > TIME_SYNC_WINDOW {
            self.window.remove(0);
        }
        Some(sample)
    }

    /// Best current estimate: the offset of the minimum-RTT sample in the
    /// window (min-RTT filtering per §6.7).
    pub fn offset_us(&self) -> Option<i64> {
        self.window
            .iter()
            .min_by_key(|s| s.rtt_us)
            .map(|s| s.offset_us)
    }

    pub fn best_rtt_us(&self) -> Option<u64> {
        self.window.iter().map(|s| s.rtt_us).min()
    }

    pub fn sample_count(&self) -> usize {
        self.window.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Simulate a link with a fixed true offset and variable jitter; the
    /// min-RTT filter must recover the true offset from the cleanest sample.
    #[test]
    fn min_rtt_filtering_recovers_offset() {
        let true_offset: i64 = 250_000; // remote runs 250ms ahead
        let mut sync = TimeSync::new();
        let jitters: [(u64, u64); 5] = [
            (40_000, 5_000),
            (2_000, 1_500),
            (80_000, 60_000),
            (10_000, 0),
            (30_000, 30_000),
        ];
        let mut now: u64 = 1_000_000;
        for (out_jitter, back_jitter) in jitters {
            let ping = sync.ping(now);
            let one_way = 15_000;
            let t2 = (now as i64 + true_offset) as u64 + one_way + out_jitter;
            let t3 = t2 + 200; // processing
            let t4 = (t3 as i64 - true_offset) as u64 + one_way + back_jitter;
            let pong = TimeSync::pong_for(&ping, t2, t3);
            sync.handle_pong(&pong, t4).expect("valid sample");
            now = t4 + 100_000;
        }
        // Cleanest sample had symmetric jitter (2_000, 1_500): offset error
        // = (out - back)/2 = 250µs.
        let est = sync.offset_us().unwrap();
        assert!(
            (est - true_offset).abs() <= 1_000,
            "estimate {est} vs {true_offset}"
        );
    }

    #[test]
    fn ignores_unknown_and_mangled_pongs() {
        let mut sync = TimeSync::new();
        let ping = sync.ping(1_000);
        let bogus = TimePong {
            ping_id: ping.ping_id + 7,
            t1: ping.t1,
            t2: 5,
            t3: 6,
        };
        assert_eq!(sync.handle_pong(&bogus, 2_000), None);
        let mangled = TimePong {
            ping_id: ping.ping_id,
            t1: ping.t1 + 1,
            t2: 5,
            t3: 6,
        };
        assert_eq!(sync.handle_pong(&mangled, 2_000), None);
        assert_eq!(sync.sample_count(), 0);
    }

    #[test]
    fn window_bounded() {
        let mut sync = TimeSync::new();
        for i in 0..40u64 {
            let ping = sync.ping(i * 1_000);
            let pong = TimeSync::pong_for(&ping, i * 1_000 + 10, i * 1_000 + 12);
            sync.handle_pong(&pong, i * 1_000 + 25);
        }
        assert_eq!(sync.sample_count(), TIME_SYNC_WINDOW);
    }
}
