//! Applying CodeMirror 6 `ChangeSet.toJSON()` payloads to a rope.
//!
//! Format: an array whose items are either a number (retain that many UTF-16 code
//! units) or an array `[deleteLen, ...insertedLines]`. Inserted lines are joined with
//! "\n". The sum of retained + deleted lengths must equal the document length.

use ropey::Rope;
use serde_json::Value;

pub fn apply_changes(rope: &mut Rope, changes: &Value) -> Result<(), &'static str> {
    let parts = changes.as_array().ok_or("changes must be an array")?;

    // Validate everything before touching the document.
    let doc_len = rope.len_utf16_cu();
    let mut covered: usize = 0;
    for part in parts {
        match part {
            Value::Number(n) => {
                let n = n.as_u64().ok_or("invalid retain length")? as usize;
                covered = covered.checked_add(n).ok_or("length overflow")?;
            }
            Value::Array(a) => {
                let del = a
                    .first()
                    .and_then(Value::as_u64)
                    .ok_or("invalid change entry")? as usize;
                covered = covered.checked_add(del).ok_or("length overflow")?;
                for line in &a[1..] {
                    let s = line.as_str().ok_or("inserted text must be strings")?;
                    if s.contains(|c| c == '\n' || c == '\r') {
                        return Err("inserted line contains a line break");
                    }
                }
            }
            _ => return Err("invalid change entry"),
        }
    }
    if covered != doc_len {
        return Err("change set length does not match the document");
    }

    // Apply. `pos` is a UTF-16 offset into the rope as it is being modified.
    let mut pos = 0usize;
    for part in parts {
        match part {
            Value::Number(n) => pos += n.as_u64().unwrap_or(0) as usize,
            Value::Array(a) => {
                let del = a[0].as_u64().unwrap_or(0) as usize;
                let start = rope.utf16_cu_to_char(pos);
                if del > 0 {
                    let end = rope.utf16_cu_to_char(pos + del);
                    rope.remove(start..end);
                }
                if a.len() > 1 {
                    let mut text = String::new();
                    for (i, line) in a[1..].iter().enumerate() {
                        if i > 0 {
                            text.push('\n');
                        }
                        text.push_str(line.as_str().unwrap_or(""));
                    }
                    if !text.is_empty() {
                        rope.insert(start, &text);
                        pos += text.encode_utf16().count();
                    }
                }
            }
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(doc: &str, ch: Value) -> Result<String, &'static str> {
        let mut r = Rope::from_str(doc);
        apply_changes(&mut r, &ch)?;
        Ok(r.to_string())
    }

    #[test]
    fn insert_at_end() {
        assert_eq!(
            run("hello", json!([5, [0, " world"]])).unwrap(),
            "hello world"
        );
    }

    #[test]
    fn replace_multiline() {
        assert_eq!(run("abc", json!([1, [1, "x", "y"], 1])).unwrap(), "ax\nyc");
    }

    #[test]
    fn delete_only() {
        assert_eq!(run("abcdef", json!([1, [3], 2])).unwrap(), "aef");
    }

    #[test]
    fn multiple_edits() {
        assert_eq!(
            run("one two three", json!([[3, "1"], 5, [5, "3"]])).unwrap(),
            "1 two 3"
        );
    }

    #[test]
    fn utf16_positions() {
        // The emoji is two UTF-16 code units.
        assert_eq!(run("a\u{1F600}b", json!([3, [1]])).unwrap(), "a\u{1F600}");
        assert_eq!(
            run("a\u{1F600}b", json!([3, [0, "!"], 1])).unwrap(),
            "a\u{1F600}!b"
        );
    }

    #[test]
    fn length_mismatch_rejected() {
        assert!(run("abc", json!([2])).is_err());
        assert!(run("abc", json!([5])).is_err());
    }

    #[test]
    fn newline_in_line_rejected() {
        assert!(run("", json!([[0, "a\nb"]])).is_err());
    }
}
