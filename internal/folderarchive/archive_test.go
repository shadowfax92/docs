package folderarchive

import (
	"archive/zip"
	"bytes"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestNewArchivesRegularFilesByRelativePath(t *testing.T) {
	dir := t.TempDir()
	writeTestFile(t, filepath.Join(dir, "zeta.txt"), "last")
	writeTestFile(t, filepath.Join(dir, "nested", "alpha.md"), "first")
	writeTestFile(t, filepath.Join(dir, "nested", "asset.bin"), "\x00\x01")

	archive, err := New(dir, 1024)
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}
	defer archive.Content.Close()

	if archive.Filename != filepath.Base(dir)+".zip" {
		t.Fatalf("Filename = %q, want folder zip filename", archive.Filename)
	}
	got := readZipEntries(t, archive.Content)
	want := map[string]string{
		"nested/alpha.md":  "first",
		"nested/asset.bin": "\x00\x01",
		"zeta.txt":         "last",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("entries = %#v, want %#v", got, want)
	}
}

func TestNewEmitsFilesInDeterministicOrder(t *testing.T) {
	dir := t.TempDir()
	writeTestFile(t, filepath.Join(dir, "b.txt"), "b")
	writeTestFile(t, filepath.Join(dir, "a.txt"), "a")

	archive, err := New(dir, 1024)
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}
	defer archive.Content.Close()

	data, err := io.ReadAll(archive.Content)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("NewReader: %v", err)
	}
	var names []string
	for _, file := range reader.File {
		names = append(names, file.Name)
	}
	if !reflect.DeepEqual(names, []string{"a.txt", "b.txt"}) {
		t.Fatalf("names = %#v, want sorted relative paths", names)
	}
}

func TestNewRejectsOverLimitDirectory(t *testing.T) {
	dir := t.TempDir()
	writeTestFile(t, filepath.Join(dir, "large.txt"), "12345")

	_, err := New(dir, 4)
	if err == nil {
		t.Fatal("New returned nil error")
	}
	if !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("error = %q, want size limit error", err.Error())
	}
}

func TestNewRejectsEmptyDirectory(t *testing.T) {
	dir := t.TempDir()

	_, err := New(dir, 1024)
	if err == nil {
		t.Fatal("New returned nil error")
	}
	if !strings.Contains(err.Error(), "no regular files found") {
		t.Fatalf("error = %q, want no-files error", err.Error())
	}
}

func TestNewRejectsNonRegularFiles(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target.txt")
	link := filepath.Join(dir, "link.txt")
	writeTestFile(t, target, "target")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("Symlink: %v", err)
	}

	_, err := New(dir, 1024)
	if err == nil {
		t.Fatal("New returned nil error")
	}
	if !strings.Contains(err.Error(), "non-regular file") {
		t.Fatalf("error = %q, want non-regular file error", err.Error())
	}
}

func TestWriteZipRejectsFileChangedAfterScan(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "file.txt")
	writeTestFile(t, path, "small")

	files, err := collectFiles(dir, 1024)
	if err != nil {
		t.Fatalf("collectFiles returned error: %v", err)
	}
	writeTestFile(t, path, "larger contents")

	err = writeZip(io.Discard, files)
	if err == nil {
		t.Fatal("writeZip returned nil error")
	}
	if !strings.Contains(err.Error(), "changed during archive") {
		t.Fatalf("error = %q, want changed-file error", err.Error())
	}
}

func readZipEntries(t *testing.T, r io.Reader) map[string]string {
	t.Helper()
	data, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("NewReader: %v", err)
	}
	entries := make(map[string]string)
	for _, file := range reader.File {
		rc, err := file.Open()
		if err != nil {
			t.Fatalf("Open(%q): %v", file.Name, err)
		}
		contents, err := io.ReadAll(rc)
		closeErr := rc.Close()
		if err != nil {
			t.Fatalf("ReadAll(%q): %v", file.Name, err)
		}
		if closeErr != nil {
			t.Fatalf("Close(%q): %v", file.Name, closeErr)
		}
		entries[file.Name] = string(contents)
	}
	return entries
}

func writeTestFile(t *testing.T, path string, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll(%q): %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatalf("WriteFile(%q): %v", path, err)
	}
}
