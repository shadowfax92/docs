package folderarchive

import (
	"archive/zip"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteZipIncludesRegularFilesWithRelativePaths(t *testing.T) {
	sourceDir := t.TempDir()
	writeArchiveTestFile(t, filepath.Join(sourceDir, "intro.md"), "hello\n")
	writeArchiveTestFile(t, filepath.Join(sourceDir, "nested", "asset.bin"), "\x00\x01\x02")

	archivePath := filepath.Join(t.TempDir(), "folder.zip")
	if err := WriteZip(sourceDir, archivePath, 1024); err != nil {
		t.Fatalf("WriteZip returned error: %v", err)
	}

	reader, err := zip.OpenReader(archivePath)
	if err != nil {
		t.Fatalf("OpenReader: %v", err)
	}
	defer reader.Close()

	got := make(map[string]string)
	for _, file := range reader.File {
		rc, err := file.Open()
		if err != nil {
			t.Fatalf("Open %q: %v", file.Name, err)
		}
		contents, err := os.ReadFile(filepath.Join(sourceDir, filepath.FromSlash(file.Name)))
		if err != nil {
			t.Fatalf("ReadFile source %q: %v", file.Name, err)
		}
		archived, err := io.ReadAll(rc)
		if closeErr := rc.Close(); closeErr != nil {
			t.Fatalf("close archived %q: %v", file.Name, closeErr)
		}
		if err != nil {
			t.Fatalf("read archived %q: %v", file.Name, err)
		}
		if string(archived) != string(contents) {
			t.Fatalf("archived %q = %q, want source contents", file.Name, string(archived))
		}
		got[file.Name] = string(archived)
	}

	if _, ok := got["intro.md"]; !ok {
		t.Fatalf("archive entries = %v, want intro.md", got)
	}
	if _, ok := got["nested/asset.bin"]; !ok {
		t.Fatalf("archive entries = %v, want nested/asset.bin", got)
	}
}

func TestWriteZipRejectsOverLimit(t *testing.T) {
	sourceDir := t.TempDir()
	writeArchiveTestFile(t, filepath.Join(sourceDir, "large.txt"), "123456")
	archivePath := filepath.Join(t.TempDir(), "folder.zip")

	err := WriteZip(sourceDir, archivePath, 5)
	if err == nil {
		t.Fatal("WriteZip returned nil error")
	}
	if !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("error = %q, want size limit guidance", err.Error())
	}
	if _, statErr := os.Stat(archivePath); !os.IsNotExist(statErr) {
		t.Fatalf("archive exists after failure, stat error = %v", statErr)
	}
}

func TestWriteZipRejectsDirectoryWithNoRegularFiles(t *testing.T) {
	sourceDir := t.TempDir()
	if err := os.Mkdir(filepath.Join(sourceDir, "empty"), 0o755); err != nil {
		t.Fatalf("Mkdir: %v", err)
	}
	archivePath := filepath.Join(t.TempDir(), "folder.zip")

	err := WriteZip(sourceDir, archivePath, 1024)
	if err == nil {
		t.Fatal("WriteZip returned nil error")
	}
	if !strings.Contains(err.Error(), "no regular files") {
		t.Fatalf("error = %q, want no regular files guidance", err.Error())
	}
}

func writeArchiveTestFile(t *testing.T, path string, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll(%q): %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatalf("WriteFile(%q): %v", path, err)
	}
}
