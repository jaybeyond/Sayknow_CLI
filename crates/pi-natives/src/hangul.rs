//! Hangul syllable primitives for text matching.
//!
//! Korean names reach the matcher in two Unicode forms: macOS volumes commonly
//! report canonically decomposed (NFD) conjoining jamo while composer input is
//! precomposed (NFC), so byte comparison of the same visible name fails. The
//! Hangul syllable block is a pure arithmetic composition (UAX #15 "Hangul
//! Syllable Composition"), so composing a name and reading its initial
//! consonant needs no normalization table and no extra dependency.

use std::borrow::Cow;

const S_BASE: u32 = 0xac00;
const L_BASE: u32 = 0x1100;
const V_BASE: u32 = 0x1161;
const T_BASE: u32 = 0x11a7;
const L_COUNT: u32 = 19;
const V_COUNT: u32 = 21;
const T_COUNT: u32 = 28;
const N_COUNT: u32 = V_COUNT * T_COUNT;
const S_COUNT: u32 = L_COUNT * N_COUNT;

const JAMO_BLOCK_START: u32 = 0x1100;
const JAMO_BLOCK_END: u32 = 0x11ff;
const COMPAT_CONSONANT_START: u32 = 0x3131;
const COMPAT_CONSONANT_END: u32 = 0x314e;

/// Compatibility jamo (U+3131..U+314E) for each of the 19 choseong indices, in
/// choseong order. Only these 19 consonants can lead a syllable; the remaining
/// compatibility consonants are clusters that appear only as a trailing jamo.
const CHOSEONG_COMPAT: [char; L_COUNT as usize] = [
	'ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ',
	'ㅌ', 'ㅍ', 'ㅎ',
];

enum Pending {
	None,
	/// A lead consonant is held until we know whether a vowel follows it.
	Lead(u32),
	/// A lead+vowel pair is held until we know whether a trailing jamo follows.
	Syllable(u32, u32),
}

fn lead_index(code: u32) -> Option<u32> {
	(L_BASE..L_BASE + L_COUNT)
		.contains(&code)
		.then(|| code - L_BASE)
}

fn vowel_index(code: u32) -> Option<u32> {
	(V_BASE..V_BASE + V_COUNT)
		.contains(&code)
		.then(|| code - V_BASE)
}

fn trailing_index(code: u32) -> Option<u32> {
	// T index 0 means "no trailing jamo", so U+11A7 itself is never a filler here.
	(T_BASE + 1..T_BASE + T_COUNT)
		.contains(&code)
		.then(|| code - T_BASE)
}

fn lead_char(l_index: u32) -> char {
	char::from_u32(L_BASE + l_index).unwrap_or('\u{fffd}')
}

fn syllable(l_index: u32, v_index: u32, t_index: u32) -> char {
	let code = S_BASE + (l_index * V_COUNT + v_index) * T_COUNT + t_index;
	char::from_u32(code).unwrap_or('\u{fffd}')
}

/// True when `value` holds at least one conjoining jamo, the only case where
/// [`compose`] can change the string.
pub fn contains_conjoining_jamo(value: &str) -> bool {
	value
		.chars()
		.any(|ch| (JAMO_BLOCK_START..=JAMO_BLOCK_END).contains(&(ch as u32)))
}

/// True for a Hangul compatibility consonant (U+3131..U+314E), which is what a
/// keyboard emits for a bare consonant such as `ㅎ`.
pub fn is_compat_consonant(ch: char) -> bool {
	(COMPAT_CONSONANT_START..=COMPAT_CONSONANT_END).contains(&(ch as u32))
}

/// Combine conjoining jamo into precomposed syllables, leaving every other
/// character untouched. Borrowed unchanged when there is nothing to compose.
pub fn compose(value: &str) -> Cow<'_, str> {
	if !contains_conjoining_jamo(value) {
		return Cow::Borrowed(value);
	}

	let mut out = String::with_capacity(value.len());
	let mut pending = Pending::None;
	for ch in value.chars() {
		let code = ch as u32;
		match pending {
			Pending::Lead(l_index) => {
				if let Some(v_index) = vowel_index(code) {
					pending = Pending::Syllable(l_index, v_index);
					continue;
				}
				out.push(lead_char(l_index));
				pending = Pending::None;
			},
			Pending::Syllable(l_index, v_index) => {
				if let Some(t_index) = trailing_index(code) {
					out.push(syllable(l_index, v_index, t_index));
					pending = Pending::None;
					continue;
				}
				out.push(syllable(l_index, v_index, 0));
				pending = Pending::None;
			},
			Pending::None => {},
		}

		match lead_index(code) {
			Some(l_index) => pending = Pending::Lead(l_index),
			None => out.push(ch),
		}
	}

	match pending {
		Pending::Lead(l_index) => out.push(lead_char(l_index)),
		Pending::Syllable(l_index, v_index) => out.push(syllable(l_index, v_index, 0)),
		Pending::None => {},
	}
	Cow::Owned(out)
}

/// Compatibility-jamo initial consonant of a precomposed syllable or a bare
/// conjoining lead jamo. `None` for every other character.
pub fn choseong_of(ch: char) -> Option<char> {
	let code = ch as u32;
	if (S_BASE..S_BASE + S_COUNT).contains(&code) {
		let l_index = (code - S_BASE) / N_COUNT;
		return CHOSEONG_COMPAT.get(l_index as usize).copied();
	}
	lead_index(code).and_then(|l_index| CHOSEONG_COMPAT.get(l_index as usize).copied())
}

/// True when `target_ch` satisfies `query_ch` under chosung rules.
///
/// An exact character always matches, and a bare compatibility consonant
/// additionally matches any syllable carrying that consonant as its initial.
pub fn matches_char(query_ch: char, target_ch: char) -> bool {
	if query_ch == target_ch {
		return true;
	}
	if !is_compat_consonant(query_ch) {
		return false;
	}
	choseong_of(target_ch) == Some(query_ch)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn composes_decomposed_syllables() {
		// macOS NFD form of `한글`: L+V+T, L+V+T.
		let nfd = "\u{1112}\u{1161}\u{11ab}\u{1100}\u{1173}\u{11af}.txt";
		assert_eq!(compose(nfd), "한글.txt");
	}

	#[test]
	fn composes_syllable_without_trailing_jamo() {
		assert_eq!(compose("\u{1112}\u{1161}"), "하");
	}

	#[test]
	fn borrows_when_nothing_to_compose() {
		assert!(matches!(compose("한글.txt"), Cow::Borrowed(_)));
		assert!(matches!(compose("plain.txt"), Cow::Borrowed(_)));
	}

	#[test]
	fn keeps_surrounding_text_and_dangling_jamo() {
		assert_eq!(compose("src/\u{1112}\u{1161}\u{11ab}-a.ts"), "src/한-a.ts");
		// A lead jamo with no vowel is emitted as-is rather than dropped.
		assert_eq!(compose("\u{1112}x"), "\u{1112}x");
	}

	#[test]
	fn reads_initial_consonant() {
		assert_eq!(choseong_of('한'), Some('ㅎ'));
		assert_eq!(choseong_of('글'), Some('ㄱ'));
		assert_eq!(choseong_of('짜'), Some('ㅉ'));
		assert_eq!(choseong_of('a'), None);
		assert_eq!(choseong_of('ㅎ'), None);
	}

	#[test]
	fn matches_bare_consonant_against_syllable() {
		assert!(matches_char('ㅎ', '한'));
		assert!(matches_char('ㄱ', '글'));
		assert!(!matches_char('ㄱ', '한'));
		// A full syllable never widens to another syllable.
		assert!(!matches_char('한', '함'));
		assert!(matches_char('한', '한'));
		// Vowels are not chosung queries.
		assert!(!matches_char('ㅏ', '한'));
	}

	#[test]
	fn identifies_compat_consonants() {
		assert!(is_compat_consonant('ㄱ'));
		assert!(is_compat_consonant('ㅎ'));
		assert!(!is_compat_consonant('ㅏ'));
		assert!(!is_compat_consonant('한'));
		assert!(!is_compat_consonant('a'));
	}
}
