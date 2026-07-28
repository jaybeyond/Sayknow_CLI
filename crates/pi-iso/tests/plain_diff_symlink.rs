#![cfg(unix)]

use std::{
	ffi::OsString,
	fs,
	os::unix::{ffi::OsStringExt, fs::symlink},
	path::{Path, PathBuf},
	sync::atomic::{AtomicU64, Ordering},
};

use pi_iso::{BackendKind, ChangeKind, backend};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

struct Fixture {
	root:    PathBuf,
	lower:   PathBuf,
	merged:  PathBuf,
	outside: PathBuf,
}

impl Fixture {
	fn new() -> Self {
		let sequence = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
		let root =
			std::env::temp_dir().join(format!("pi-iso-plain-diff-{}-{sequence}", std::process::id()));
		let lower = root.join("lower");
		let merged = root.join("merged");
		let outside = root.join("outside");
		fs::create_dir_all(&lower).unwrap();
		fs::create_dir_all(&merged).unwrap();
		fs::create_dir_all(&outside).unwrap();
		Self { root, lower, merged, outside }
	}

	fn write_secret(&self, name: &str, contents: &str) -> PathBuf {
		let path = self.outside.join(name);
		fs::write(&path, contents).unwrap();
		path
	}
}

impl Drop for Fixture {
	fn drop(&mut self) {
		let _ = fs::remove_dir_all(&self.root);
	}
}

fn assert_link_payload(diff: &str, target: &Path, secret: &str) {
	assert!(diff.contains(&target.to_string_lossy().into_owned()));
	assert!(!diff.contains(secret));
}

#[tokio::test]
async fn added_symlink_diffs_its_payload_without_reading_the_target() {
	let fixture = Fixture::new();
	let target = fixture.write_secret("added-secret.txt", "added operator secret");
	symlink(&target, fixture.merged.join("escape.txt")).unwrap();

	let diff = backend(BackendKind::Rcopy)
		.diff(&fixture.lower, &fixture.merged)
		.await
		.unwrap();

	assert_eq!(diff.files.len(), 1);
	assert_eq!(diff.files[0].op, ChangeKind::Added);
	let file_diff = diff.files[0].diff.as_deref().unwrap();
	let unified = diff.unified_text();
	assert!(unified.contains("new file mode 120000"));
	assert_link_payload(file_diff, &target, "added operator secret");
	assert_link_payload(&unified, &target, "added operator secret");
}

#[tokio::test]
async fn modified_symlink_compares_payloads_without_reading_either_target() {
	let fixture = Fixture::new();
	let old_target = fixture.write_secret("old-secret.txt", "old operator secret");
	let new_target = fixture.write_secret("new-secret.txt", "new operator secret");
	symlink(&old_target, fixture.lower.join("escape.txt")).unwrap();
	symlink(&new_target, fixture.merged.join("escape.txt")).unwrap();

	let diff = backend(BackendKind::Rcopy)
		.diff(&fixture.lower, &fixture.merged)
		.await
		.unwrap();

	assert_eq!(diff.files.len(), 1);
	assert_eq!(diff.files[0].op, ChangeKind::Modified);
	let file_diff = diff.files[0].diff.as_deref().unwrap();
	let unified = diff.unified_text();
	assert_link_payload(file_diff, &old_target, "old operator secret");
	assert_link_payload(file_diff, &new_target, "new operator secret");
	assert_link_payload(&unified, &old_target, "old operator secret");
	assert_link_payload(&unified, &new_target, "new operator secret");
}

#[tokio::test]
async fn file_replaced_by_symlink_records_the_type_change_without_reading_the_target() {
	let fixture = Fixture::new();
	let target = fixture.write_secret("replacement.txt", "replacement operator secret");
	let path = Path::new("escape.txt");
	let old_contents = "x".repeat(target.as_os_str().as_encoded_bytes().len());
	fs::write(fixture.lower.join(path), old_contents).unwrap();
	symlink(&target, fixture.merged.join(path)).unwrap();

	let diff = backend(BackendKind::Rcopy)
		.diff(&fixture.lower, &fixture.merged)
		.await
		.unwrap();

	assert_eq!(diff.files.len(), 1);
	assert_eq!(diff.files[0].op, ChangeKind::Modified);
	let file_diff = diff.files[0].diff.as_deref().unwrap();
	let unified = diff.unified_text();
	assert!(unified.contains("old mode 100644"));
	assert!(unified.contains("new mode 120000"));
	assert_link_payload(file_diff, &target, "replacement operator secret");
	assert_link_payload(&unified, &target, "replacement operator secret");
}

#[tokio::test]
async fn removed_symlink_diffs_its_payload_without_reading_the_target() {
	let fixture = Fixture::new();
	let target = fixture.write_secret("removed-secret.txt", "removed operator secret");
	symlink(&target, fixture.lower.join("escape.txt")).unwrap();

	let diff = backend(BackendKind::Rcopy)
		.diff(&fixture.lower, &fixture.merged)
		.await
		.unwrap();

	assert_eq!(diff.files.len(), 1);
	assert_eq!(diff.files[0].op, ChangeKind::Removed);
	let file_diff = diff.files[0].diff.as_deref().unwrap();
	let unified = diff.unified_text();
	assert!(unified.contains("deleted file mode 120000"));
	assert_link_payload(file_diff, &target, "removed operator secret");
	assert_link_payload(&unified, &target, "removed operator secret");
}

#[tokio::test]
async fn non_utf8_symlink_target_fails_closed_instead_of_requesting_path_copy() {
	let fixture = Fixture::new();
	let target = PathBuf::from(OsString::from_vec(vec![b'.', b'.', b'/', 0xff]));
	symlink(target, fixture.merged.join("escape.txt")).unwrap();

	let error = backend(BackendKind::Rcopy)
		.diff(&fixture.lower, &fixture.merged)
		.await
		.unwrap_err();

	assert!(
		error
			.message()
			.contains("symlink change is not text-representable")
	);
	assert!(error.message().contains("escape.txt"));
}

#[tokio::test]
async fn binary_file_replaced_by_symlink_fails_closed_instead_of_requesting_path_copy() {
	let fixture = Fixture::new();
	let target = fixture.write_secret("binary-replacement.txt", "binary replacement secret");
	fs::write(fixture.lower.join("escape.bin"), b"before\0binary").unwrap();
	symlink(&target, fixture.merged.join("escape.bin")).unwrap();

	let error = backend(BackendKind::Rcopy)
		.diff(&fixture.lower, &fixture.merged)
		.await
		.unwrap_err();

	assert!(
		error
			.message()
			.contains("symlink change is not text-representable")
	);
	assert!(error.message().contains("escape.bin"));
	assert!(!error.message().contains("binary replacement secret"));
}
