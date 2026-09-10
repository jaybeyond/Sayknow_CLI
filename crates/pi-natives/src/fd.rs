//! Fuzzy file path discovery for autocomplete and @-mention resolution.
//!
//! Searches for files and directories whose paths match a query string via
//! subsequence scoring. Uses the shared [`fs_cache`] for directory scanning.

use std::path::Path;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::{fs_cache, hangul, task};

/// Options for fuzzy file path search.
#[napi(object)]
pub struct FuzzyFindOptions<'env> {
	/// Fuzzy query to match against file paths (case-insensitive).
	pub query:       String,
	/// Directory to search.
	pub path:        String,
	/// Include hidden files (default: false).
	pub hidden:      Option<bool>,
	/// Respect .gitignore (default: true).
	pub gitignore:   Option<bool>,
	/// Enable shared filesystem scan cache (default: false).
	pub cache:       Option<bool>,
	/// Maximum number of matches to return (default: 100).
	pub max_results: Option<u32>,
	/// Abort signal for cancelling the operation.
	pub signal:      Option<Unknown<'env>>,
	/// Timeout in milliseconds for the operation.
	pub timeout_ms:  Option<u32>,
}

/// A single match in fuzzy find results.
#[napi(object)]
pub struct FuzzyFindMatch {
	/// Relative path from the search root (uses `/` separators).
	pub path:         String,
	/// Whether this entry is a directory.
	pub is_directory: bool,
	/// Match quality score (higher is better).
	pub score:        u32,
}

/// Result of fuzzy file path search.
#[napi(object)]
pub struct FuzzyFindResult {
	/// Matched entries (up to `maxResults`).
	pub matches:       Vec<FuzzyFindMatch>,
	/// Total number of matches found (may exceed `matches.len()`).
	pub total_matches: u32,
}

/// Query built once per search so per-entry scoring stays allocation-light.
struct FuzzyQuery {
	/// Composed, lowercased raw query; used for exact/prefix/contains lanes.
	lower:      String,
	/// Separator-stripped form used by the subsequence lanes.
	normalized: String,
	/// Characters of `normalized`.
	chars:      Vec<char>,
	/// Set when the query holds at least one Hangul compatibility consonant,
	/// the only case where the chosung lane can produce a match the other
	/// lanes cannot.
	chosung:    bool,
}

fn normalize_fuzzy_text(value: &str) -> String {
	let composed = hangul::compose(value);
	composed
		.chars()
		.filter(|ch| !ch.is_whitespace() && !matches!(ch, '/' | '\\' | '.' | '_' | '-'))
		.flat_map(|ch| ch.to_lowercase())
		.collect()
}

fn fuzzy_subsequence_score(query_chars: &[char], target: &str) -> u32 {
	if query_chars.is_empty() {
		return 1;
	}
	let mut query_index = 0usize;
	let mut gaps = 0u32;
	let mut last_match_index: Option<usize> = None;
	for (target_index, target_ch) in target.chars().enumerate() {
		if query_index >= query_chars.len() {
			break;
		}
		if query_chars[query_index] == target_ch {
			if let Some(last_index) = last_match_index
				&& target_index > last_index + 1
			{
				gaps = gaps.saturating_add(1);
			}
			last_match_index = Some(target_index);
			query_index += 1;
		}
	}
	if query_index != query_chars.len() {
		return 0;
	}
	let gap_penalty = gaps.saturating_mul(5);
	40u32.saturating_sub(gap_penalty).max(1)
}

/// Subsequence score under Hangul chosung rules, where a bare compatibility
/// consonant matches any syllable carrying it as the initial. Deliberately
/// scored in a band strictly below every literal and full-syllable lane so a
/// real name match always outranks a consonant-skeleton match.
fn chosung_subsequence_score(query_chars: &[char], target: &str) -> u32 {
	if query_chars.is_empty() {
		return 0;
	}
	let mut query_index = 0usize;
	let mut gaps = 0u32;
	let mut last_match_index: Option<usize> = None;
	for (target_index, target_ch) in target.chars().enumerate() {
		if query_index >= query_chars.len() {
			break;
		}
		if hangul::matches_char(query_chars[query_index], target_ch) {
			if let Some(last_index) = last_match_index
				&& target_index > last_index + 1
			{
				gaps = gaps.saturating_add(1);
			}
			last_match_index = Some(target_index);
			query_index += 1;
		}
	}
	if query_index != query_chars.len() {
		return 0;
	}
	let contiguous_bonus = if gaps == 0 { 5 } else { 0 };
	let gap_penalty = gaps.saturating_mul(2);
	(10u32 + contiguous_bonus)
		.saturating_sub(gap_penalty)
		.max(1)
}

fn score_fuzzy_path(path: &str, is_directory: bool, query: &FuzzyQuery) -> u32 {
	if query.lower.is_empty() {
		return if is_directory { 11 } else { 1 };
	}

	// Match against the full relative path only when the user typed a path-style
	// query (contains '/'). Plain queries should match by basename only, otherwise
	// '@plan' surfaces every file whose ancestor directories contain 'plan'.
	let query_has_slash = query.lower.contains('/');

	let file_name = Path::new(path)
		.file_name()
		.and_then(|name| name.to_str())
		.unwrap_or(path);
	// Compose before comparing: macOS reports Korean names as decomposed jamo
	// while the composer sends precomposed syllables, so the same visible name
	// would otherwise never match.
	let lower_file_name = hangul::compose(file_name).to_lowercase();

	let mut score = if lower_file_name == query.lower {
		120
	} else if lower_file_name.starts_with(&query.lower) {
		100
	} else if lower_file_name.contains(&query.lower) {
		80
	} else if !query_has_slash {
		let normalized_file_name = normalize_fuzzy_text(file_name);
		let file_name_fuzzy = fuzzy_subsequence_score(&query.chars, &normalized_file_name);
		if file_name_fuzzy > 0 {
			50 + file_name_fuzzy
		} else {
			0
		}
	} else {
		let lower_path = hangul::compose(path).to_lowercase();
		if lower_path.contains(&query.lower) {
			60
		} else {
			let normalized_file_name = normalize_fuzzy_text(file_name);
			let file_name_fuzzy = fuzzy_subsequence_score(&query.chars, &normalized_file_name);
			if file_name_fuzzy > 0 {
				50 + file_name_fuzzy
			} else {
				let normalized_path = normalize_fuzzy_text(path);
				let path_fuzzy = if normalized_path == query.normalized {
					40
				} else {
					fuzzy_subsequence_score(&query.chars, &normalized_path)
				};
				if path_fuzzy > 0 { 30 + path_fuzzy } else { 0 }
			}
		}
	};

	// Chosung lane runs only after every literal lane declined and only for a
	// query that actually carries a bare consonant, so ordinary queries pay
	// nothing for it.
	if score == 0 && query.chosung {
		let normalized_file_name = normalize_fuzzy_text(file_name);
		score = chosung_subsequence_score(&query.chars, &normalized_file_name);
	}

	if is_directory && score > 0 {
		score += 10;
	}

	score
}

struct FuzzyFindConfig {
	query:       String,
	path:        String,
	hidden:      Option<bool>,
	gitignore:   Option<bool>,
	max_results: Option<u32>,
	cache:       Option<bool>,
}

fn score_entries(
	entries: &[fs_cache::GlobMatch],
	query: &FuzzyQuery,
	ct: &task::CancelToken,
) -> Result<Vec<FuzzyFindMatch>> {
	let mut scored = Vec::with_capacity(entries.len().min(256));
	for entry in entries {
		ct.heartbeat()?;
		if entry.file_type == fs_cache::FileType::Symlink {
			continue;
		}

		let is_directory = entry.file_type == fs_cache::FileType::Dir;
		let score = score_fuzzy_path(&entry.path, is_directory, query);
		if score == 0 {
			continue;
		}

		let mut path = entry.path.clone();
		if is_directory {
			path.push('/');
		}
		scored.push(FuzzyFindMatch { path, is_directory, score });
	}
	Ok(scored)
}

fn fuzzy_find_sync(config: FuzzyFindConfig, ct: task::CancelToken) -> Result<FuzzyFindResult> {
	let root = fs_cache::resolve_search_path(&config.path)?;
	let include_hidden = config.hidden.unwrap_or(false);
	let respect_gitignore = config.gitignore.unwrap_or(true);
	let max_results = config.max_results.unwrap_or(100) as usize;
	if max_results == 0 {
		return Ok(FuzzyFindResult { matches: Vec::new(), total_matches: 0 });
	}

	// Compose the query too: a name dragged in from Finder can arrive decomposed.
	let query_lower = hangul::compose(config.query.trim()).to_lowercase();
	let normalized_query = normalize_fuzzy_text(&query_lower);
	let query_chars: Vec<char> = normalized_query.chars().collect();
	let query_chosung = query_chars.iter().copied().any(hangul::is_compat_consonant);
	if !query_lower.is_empty() && normalized_query.is_empty() {
		return Ok(FuzzyFindResult { matches: Vec::new(), total_matches: 0 });
	}

	let query = FuzzyQuery {
		lower:      query_lower,
		normalized: normalized_query,
		chars:      query_chars,
		chosung:    query_chosung,
	};

	let use_cache = config.cache.unwrap_or(false);
	let scan_options = fs_cache::ScanOptions {
		include_hidden,
		use_gitignore: respect_gitignore,
		skip_node_modules: true,
		follow_links: true,
		detail: fs_cache::ScanDetail::Minimal,
	};
	let mut scored = if use_cache {
		let scan = fs_cache::get_or_scan(&root, scan_options, &ct)?;
		let mut scored = score_entries(&scan.entries, &query, &ct)?;
		if scored.is_empty()
			&& !query.lower.is_empty()
			&& scan.cache_age_ms >= fs_cache::empty_recheck_ms()
		{
			let fresh = fs_cache::force_rescan(&root, scan_options, true, &ct)?;
			scored = score_entries(&fresh, &query, &ct)?;
		}
		scored
	} else {
		let fresh = fs_cache::force_rescan(&root, scan_options, false, &ct)?;
		score_entries(&fresh, &query, &ct)?
	};

	scored.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));
	let total_matches = crate::utils::clamp_u32(scored.len() as u64);
	let matches = scored.into_iter().take(max_results).collect();
	Ok(FuzzyFindResult { matches, total_matches })
}

/// Fuzzy file path search for autocomplete.
#[napi(js_name = "fuzzyFind")]
pub fn fuzzy_find(options: FuzzyFindOptions<'_>) -> task::Promise<FuzzyFindResult> {
	let FuzzyFindOptions { query, path, hidden, gitignore, cache, max_results, timeout_ms, signal } =
		options;
	let ct = task::CancelToken::new(timeout_ms, signal);
	let config = FuzzyFindConfig { query, path, hidden, gitignore, max_results, cache };
	task::blocking("fuzzy_find", ct, move |ct| fuzzy_find_sync(config, ct))
}

#[cfg(test)]
mod tests {
	use super::*;

	fn build_query(raw: &str) -> FuzzyQuery {
		let lower = hangul::compose(raw.trim()).to_lowercase();
		let normalized = normalize_fuzzy_text(&lower);
		let chars: Vec<char> = normalized.chars().collect();
		let chosung = chars.iter().copied().any(hangul::is_compat_consonant);
		FuzzyQuery { lower, normalized, chars, chosung }
	}

	fn score(path: &str, raw_query: &str) -> u32 {
		score_fuzzy_path(path, false, &build_query(raw_query))
	}

	/// macOS reports the name decomposed; the composer sends it precomposed.
	#[test]
	fn matches_decomposed_name_against_composed_query() {
		let nfd_path = "docs/\u{1112}\u{1161}\u{11ab}\u{1100}\u{1173}\u{11af}.txt";
		assert!(score(nfd_path, "한글") > 0);
		assert_eq!(score(nfd_path, "한글"), score("docs/한글.txt", "한글"));
	}

	#[test]
	fn matches_composed_name_against_decomposed_query() {
		let nfd_query = "\u{1112}\u{1161}\u{11ab}";
		assert!(score("docs/한글.txt", nfd_query) > 0);
	}

	#[test]
	fn bare_consonants_match_syllable_initials() {
		assert!(score("docs/한글.txt", "ㅎㄱ") > 0);
		assert!(score("docs/한글.txt", "ㅎ") > 0);
		// Wrong initials must not match.
		assert_eq!(score("docs/한글.txt", "ㄴㄷ"), 0);
		// A chosung query never matches a name with no Hangul at all.
		assert_eq!(score("docs/readme.txt", "ㅎㄱ"), 0);
	}

	#[test]
	fn chosung_query_accepts_mixed_consonant_and_syllable() {
		assert!(score("docs/한글.txt", "ㅎ글") > 0);
		assert_eq!(score("docs/한글.txt", "ㅎ글자"), 0);
	}

	#[test]
	fn literal_match_outranks_chosung_match() {
		// `ㅎㄱ.txt` is a literal prefix hit; `한글.txt` is only a chosung hit.
		let literal = score("docs/ㅎㄱ.txt", "ㅎㄱ");
		let chosung = score("docs/한글.txt", "ㅎㄱ");
		assert!(chosung > 0);
		assert!(literal > chosung);
	}

	#[test]
	fn full_syllable_match_outranks_chosung_match() {
		let full = score("docs/한글.txt", "한글");
		let chosung = score("docs/한글.txt", "ㅎㄱ");
		assert!(full > chosung);
	}

	#[test]
	fn contiguous_chosung_outranks_gapped_chosung() {
		let contiguous = score("docs/한글.txt", "ㅎㄱ");
		let gapped = score("docs/한국말.txt", "ㅎㅁ");
		assert!(contiguous > 0);
		assert!(gapped > 0);
		assert!(contiguous > gapped);
	}

	#[test]
	fn ascii_scoring_is_unchanged_by_the_chosung_lane() {
		assert_eq!(score("src/agent.ts", "agent.ts"), 120);
		assert_eq!(score("src/agent.ts", "agent"), 100);
		assert_eq!(score("src/my-agent.ts", "agent"), 80);
		assert_eq!(score("src/readme.md", "zzz"), 0);
	}

	#[test]
	fn directory_bonus_applies_to_a_chosung_hit() {
		let query = build_query("ㅎㄱ");
		let file = score_fuzzy_path("docs/한글", false, &query);
		let dir = score_fuzzy_path("docs/한글", true, &query);
		assert!(file > 0);
		assert_eq!(dir, file + 10);
	}
}
