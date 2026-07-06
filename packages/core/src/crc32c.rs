//! CRC-32C (Castagnoli), the checksum over AUDIO_CHUNK payloads (RFC §6.2).
//!
//! Table-driven, reflected form of polynomial 0x1EDC6F41 (reflected constant
//! 0x82F63B78) — the same parameterization as iSCSI (RFC 3720) and the SSE4.2
//! `crc32` instruction. Hand-rolled to keep `antiphon-core` dependency-free.

const POLY_REFLECTED: u32 = 0x82F6_3B78;

const fn build_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut crc = i as u32;
        let mut bit = 0;
        while bit < 8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ POLY_REFLECTED
            } else {
                crc >> 1
            };
            bit += 1;
        }
        table[i] = crc;
        i += 1;
    }
    table
}

static TABLE: [u32; 256] = build_table();

/// CRC-32C of `data` in one shot.
pub fn crc32c(data: &[u8]) -> u32 {
    crc32c_append(0, data)
}

/// Continue a CRC-32C computation. `crc` is the value returned by a previous
/// call (0 for a fresh start).
pub fn crc32c_append(crc: u32, data: &[u8]) -> u32 {
    let mut state = !crc;
    for &byte in data {
        state = (state >> 8) ^ TABLE[((state ^ byte as u32) & 0xFF) as usize];
    }
    !state
}

#[cfg(test)]
mod tests {
    use super::*;

    // Test vectors from RFC 3720 §B.4 ("CRC Examples").
    #[test]
    fn rfc3720_all_zeros() {
        assert_eq!(crc32c(&[0u8; 32]), 0x8A91_36AA);
    }

    #[test]
    fn rfc3720_all_ones() {
        assert_eq!(crc32c(&[0xFFu8; 32]), 0x62A8_AB43);
    }

    #[test]
    fn rfc3720_incrementing() {
        let data: Vec<u8> = (0u8..32).collect();
        assert_eq!(crc32c(&data), 0x46DD_794E);
    }

    #[test]
    fn rfc3720_decrementing() {
        let data: Vec<u8> = (0u8..32).rev().collect();
        assert_eq!(crc32c(&data), 0x113F_DB5C);
    }

    // Classic check value for CRC-32C: "123456789".
    #[test]
    fn check_string() {
        assert_eq!(crc32c(b"123456789"), 0xE306_9283);
    }

    #[test]
    fn append_matches_oneshot() {
        let data = b"the antiphon calls, the phones answer";
        let split = 13;
        let partial = crc32c_append(0, &data[..split]);
        assert_eq!(crc32c_append(partial, &data[split..]), crc32c(data));
    }

    #[test]
    fn empty_is_zero() {
        assert_eq!(crc32c(&[]), 0);
    }
}
