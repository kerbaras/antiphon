//! Minimal hand-rolled JSON emission for stats/events crossing the JS
//! boundary. Values are numbers, booleans, UUID strings, and hex — no
//! arbitrary strings, so no escaping machinery is needed. (Deliberately not
//! serde: the facade stays dependency-free.)

use antiphon_core::frame::SeqRange;

pub fn uuid_string(id: &[u8; 16]) -> String {
    let h = |r: std::ops::Range<usize>| -> String {
        id[r].iter().map(|b| format!("{b:02x}")).collect()
    };
    format!(
        "{}-{}-{}-{}-{}",
        h(0..4),
        h(4..6),
        h(6..8),
        h(8..10),
        h(10..16)
    )
}

pub fn ranges_json(ranges: &[SeqRange]) -> String {
    let inner: Vec<String> = ranges
        .iter()
        .map(|r| format!("[{},{}]", r.start, r.end))
        .collect();
    format!("[{}]", inner.join(","))
}

pub struct Obj {
    parts: Vec<String>,
}

impl Obj {
    pub fn new() -> Self {
        Self { parts: Vec::new() }
    }

    pub fn num(mut self, key: &str, value: impl Into<f64>) -> Self {
        let v: f64 = value.into();
        // u64 sample indices fit f64 exactly for any real session; emit
        // integers without a fractional part.
        if v.fract() == 0.0 && v.abs() < 9.0e15 {
            self.parts.push(format!("\"{key}\":{}", v as i64));
        } else {
            self.parts.push(format!("\"{key}\":{v}"));
        }
        self
    }

    pub fn opt_num(self, key: &str, value: Option<impl Into<f64>>) -> Self {
        match value {
            Some(v) => self.num(key, v),
            None => self.raw(key, "null"),
        }
    }

    pub fn bool(mut self, key: &str, value: bool) -> Self {
        self.parts.push(format!("\"{key}\":{value}"));
        self
    }

    /// `value` must already be valid JSON (safe alphabet only).
    pub fn raw(mut self, key: &str, value: impl AsRef<str>) -> Self {
        self.parts.push(format!("\"{key}\":{}", value.as_ref()));
        self
    }

    /// `value` must contain no characters requiring JSON escaping.
    pub fn str(mut self, key: &str, value: impl AsRef<str>) -> Self {
        self.parts.push(format!("\"{key}\":\"{}\"", value.as_ref()));
        self
    }

    pub fn build(self) -> String {
        format!("{{{}}}", self.parts.join(","))
    }
}
