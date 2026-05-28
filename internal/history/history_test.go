package history

import (
	"path/filepath"
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
