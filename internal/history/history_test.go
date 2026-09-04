package history

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestStoreAppendAndListRecent(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), "uploads.json"))
	base := time.Date(2026, 5, 28, 10, 0, 0, 0, time.UTC)

	if err := store.Append(Entry{
		UploadedAt: base,
		Name:       "old.md",
		URL:        "https://docs.example/old",
		ID:         "old",
		Path:       "/tmp/old.md",
	}); err != nil {
		t.Fatalf("Append old: %v", err)
	}
	if err := store.Append(Entry{
		UploadedAt: base.Add(time.Hour),
		Name:       "new.md",
		URL:        "https://docs.example/new",
		ID:         "new",
		Path:       "/tmp/new.md",
	}); err != nil {
		t.Fatalf("Append new: %v", err)
	}

	entries, err := store.List(Filter{Limit: 1})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("len(entries) = %d, want 1", len(entries))
	}
	if entries[0].Name != "new.md" || entries[0].URL != "https://docs.example/new" {
		t.Fatalf("entry = %+v, want most recent upload", entries[0])
	}
}

func TestStoreListFiltersBySince(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), "uploads.json"))
	base := time.Date(2026, 5, 28, 10, 0, 0, 0, time.UTC)

	if err := store.Append(Entry{UploadedAt: base.Add(-48 * time.Hour), Name: "old.md", URL: "https://docs.example/old"}); err != nil {
		t.Fatalf("Append old: %v", err)
	}
	if err := store.Append(Entry{UploadedAt: base.Add(-2 * time.Hour), Name: "recent.md", URL: "https://docs.example/recent"}); err != nil {
		t.Fatalf("Append recent: %v", err)
	}

	entries, err := store.List(Filter{Since: base.Add(-24 * time.Hour)})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("len(entries) = %d, want 1", len(entries))
	}
	if entries[0].Name != "recent.md" {
		t.Fatalf("entry = %+v, want recent upload", entries[0])
	}
}

func TestDefaultPathUsesDocsConfigDir(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	path, err := DefaultPath()
	if err != nil {
		t.Fatalf("DefaultPath: %v", err)
	}
	want := filepath.Join(home, ".config", "docs", "uploads.json")
	if path != want {
		t.Fatalf("DefaultPath() = %q, want %q", path, want)
	}
}

func TestStoreRemoveByIDRemovesEveryExactMatch(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), "uploads.json"))
	base := time.Date(2026, 5, 28, 10, 0, 0, 0, time.UTC)
	entries := []Entry{
		{UploadedAt: base.Add(4 * time.Hour), Name: "prefix.md", ID: "Ab12Cd345"},
		{UploadedAt: base.Add(3 * time.Hour), Name: "first.md", ID: "Ab12Cd34"},
		{UploadedAt: base.Add(2 * time.Hour), Name: "other.md", ID: "Other123"},
		{UploadedAt: base.Add(time.Hour), Name: "duplicate.md", ID: "Ab12Cd34"},
		{UploadedAt: base, Name: "legacy.md"},
	}
	for _, entry := range entries {
		if err := store.Append(entry); err != nil {
			t.Fatalf("Append %q: %v", entry.Name, err)
		}
	}

	removed, err := store.RemoveByID("Ab12Cd34")
	if err != nil {
		t.Fatalf("RemoveByID: %v", err)
	}
	if removed != 2 {
		t.Fatalf("removed = %d, want 2", removed)
	}

	got, err := store.List(Filter{})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("len(entries) = %d, want 3", len(got))
	}
	if got[0].Name != "prefix.md" || got[1].Name != "other.md" || got[2].Name != "legacy.md" {
		t.Fatalf("remaining entries = %+v, want unrelated entries in order", got)
	}
}

func TestStoreRemoveByIDDoesNotRewriteForMissingOrEmptyID(t *testing.T) {
	path := filepath.Join(t.TempDir(), "uploads.json")
	store := NewStore(path)
	if err := store.Append(Entry{Name: "legacy.md"}); err != nil {
		t.Fatalf("Append: %v", err)
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat before removal: %v", err)
	}

	for _, id := range []string{"missing", ""} {
		removed, err := store.RemoveByID(id)
		if err != nil {
			t.Fatalf("RemoveByID(%q): %v", id, err)
		}
		if removed != 0 {
			t.Fatalf("RemoveByID(%q) removed %d entries, want 0", id, removed)
		}
	}

	after, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat after removal: %v", err)
	}
	if !os.SameFile(before, after) {
		t.Fatal("missing ID replaced history file, want no rewrite")
	}
}

func TestStoreRemoveByIDPreservesPrivateAtomicStorage(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "config", "docs")
	path := filepath.Join(dir, "uploads.json")
	store := NewStore(path)
	if err := store.Append(Entry{Name: "delete.md", ID: "Ab12Cd34"}); err != nil {
		t.Fatalf("Append delete entry: %v", err)
	}
	if err := store.Append(Entry{Name: "keep.md", ID: "Other123"}); err != nil {
		t.Fatalf("Append keep entry: %v", err)
	}

	removed, err := store.RemoveByID("Ab12Cd34")
	if err != nil {
		t.Fatalf("RemoveByID: %v", err)
	}
	if removed != 1 {
		t.Fatalf("removed = %d, want 1", removed)
	}

	dirInfo, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("Stat history directory: %v", err)
	}
	if got := dirInfo.Mode().Perm(); got != 0o700 {
		t.Fatalf("history directory permissions = %o, want 700", got)
	}
	fileInfo, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat history file: %v", err)
	}
	if got := fileInfo.Mode().Perm(); got != 0o600 {
		t.Fatalf("history file permissions = %o, want 600", got)
	}
	lockInfo, err := os.Stat(path + ".lock")
	if err != nil {
		t.Fatalf("Stat history lock file: %v", err)
	}
	if got := lockInfo.Mode().Perm(); got != 0o600 {
		t.Fatalf("history lock permissions = %o, want 600", got)
	}
	temporaryFiles, err := filepath.Glob(filepath.Join(dir, ".uploads.json.tmp-*"))
	if err != nil {
		t.Fatalf("Glob temporary history files: %v", err)
	}
	if len(temporaryFiles) != 0 {
		t.Fatalf("temporary history files remain after replace: %v", temporaryFiles)
	}
}

func TestStoreSerializesConcurrentAppendAndRemoval(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), "uploads.json"))
	if err := store.Append(Entry{Name: "delete.md", ID: "Ab12Cd34"}); err != nil {
		t.Fatalf("Append deletion target: %v", err)
	}

	const appendCount = 64
	start := make(chan struct{})
	errors := make(chan error, appendCount+1)
	var wait sync.WaitGroup
	for index := 0; index < appendCount; index++ {
		index := index
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			errors <- store.Append(Entry{Name: fmt.Sprintf("keep-%d.md", index), ID: fmt.Sprintf("Keep%04d", index)})
		}()
	}
	wait.Add(1)
	go func() {
		defer wait.Done()
		<-start
		_, err := store.RemoveByID("Ab12Cd34")
		errors <- err
	}()

	close(start)
	wait.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatalf("concurrent history update: %v", err)
		}
	}

	entries, err := store.List(Filter{})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(entries) != appendCount {
		t.Fatalf("history length = %d, want %d", len(entries), appendCount)
	}
	for _, entry := range entries {
		if entry.ID == "Ab12Cd34" {
			t.Fatal("concurrent append resurrected deleted history entry")
		}
	}
}
