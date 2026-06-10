package cmd

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunUploadArchivesDirectoryWithArbitraryFiles(t *testing.T) {
	sourceDir := t.TempDir()
	writeUploadTestFile(t, filepath.Join(sourceDir, "intro.md"), "hello\n")
	writeUploadTestFile(t, filepath.Join(sourceDir, "nested", "guide.md"), "world\n")
	writeUploadTestFile(t, filepath.Join(sourceDir, "nested", "notes.txt"), "included\n")
	writeUploadTestFile(t, filepath.Join(sourceDir, "asset.bin"), "\x00\x01")

	var uploaded map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Content-Type") != "application/zip" {
			t.Fatalf("Content-Type = %q, want application/zip", r.Header.Get("Content-Type"))
		}
		if r.Header.Get("Authorization") != "Bearer secret" {
			t.Fatalf("Authorization = %q, want bearer token", r.Header.Get("Authorization"))
		}
		if r.Header.Get("X-Filename") != filepath.Base(sourceDir)+".zip" {
			t.Fatalf("X-Filename = %q, want directory zip filename", r.Header.Get("X-Filename"))
		}
		if r.Header.Get("X-Doc-Name") != "Folder Docs" {
			t.Fatalf("X-Doc-Name = %q, want Folder Docs", r.Header.Get("X-Doc-Name"))
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("ReadAll: %v", err)
		}
		uploaded = readUploadZipEntries(t, body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"url":"https://example.test/folder","id":"folder"}`))
	}))
	defer server.Close()

	writeUploadConfig(t, server.URL, "secret")
	previousDocName := docName
	previousFolderUpload := folderUpload
	docName = "Folder Docs"
	folderUpload = true
	t.Cleanup(func() {
		docName = previousDocName
		folderUpload = previousFolderUpload
	})

	if err := runUpload(nil, []string{sourceDir}); err != nil {
		t.Fatalf("runUpload returned error: %v", err)
	}
	if uploaded["intro.md"] != "hello\n" {
		t.Fatalf("intro.md = %q, want file contents", uploaded["intro.md"])
	}
	if uploaded["nested/guide.md"] != "world\n" {
		t.Fatalf("nested/guide.md = %q, want file contents", uploaded["nested/guide.md"])
	}
	if uploaded["nested/notes.txt"] != "included\n" {
		t.Fatalf("nested/notes.txt = %q, want file contents", uploaded["nested/notes.txt"])
	}
	if uploaded["asset.bin"] != "\x00\x01" {
		t.Fatalf("asset.bin = %q, want binary contents", uploaded["asset.bin"])
	}
}

func TestRunUploadRequiresFolderFlagForDirectory(t *testing.T) {
	sourceDir := t.TempDir()
	writeUploadTestFile(t, filepath.Join(sourceDir, "intro.md"), "hello\n")

	previousFolderUpload := folderUpload
	folderUpload = false
	t.Cleanup(func() {
		folderUpload = previousFolderUpload
	})

	err := runUpload(nil, []string{sourceDir})
	if err == nil {
		t.Fatal("runUpload returned nil error")
	}
	if !strings.Contains(err.Error(), "pass --folder") {
		t.Fatalf("error = %q, want --folder guidance", err.Error())
	}
	if strings.Contains(strings.ToLower(err.Error()), "markdown") {
		t.Fatalf("error = %q, should not describe folder upload as markdown-only", err.Error())
	}
}

func TestRunUploadAcceptsArbitraryRegularFile(t *testing.T) {
	sourceDir := t.TempDir()
	filePath := filepath.Join(sourceDir, "archive.unknown")
	if err := os.WriteFile(filePath, []byte{0, 1, 2, 3, 4}, 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Content-Type") != "application/octet-stream" {
			t.Fatalf("Content-Type = %q, want application/octet-stream", r.Header.Get("Content-Type"))
		}
		if r.Header.Get("X-Filename") != "archive.unknown" {
			t.Fatalf("X-Filename = %q, want archive.unknown", r.Header.Get("X-Filename"))
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("ReadAll: %v", err)
		}
		if string(body) != string([]byte{0, 1, 2, 3, 4}) {
			t.Fatalf("body = %v, want uploaded bytes", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"url":"https://example.test/file","id":"file"}`))
	}))
	defer server.Close()

	writeUploadConfig(t, server.URL, "secret")
	previousDocName := docName
	previousFolderUpload := folderUpload
	docName = ""
	folderUpload = false
	t.Cleanup(func() {
		docName = previousDocName
		folderUpload = previousFolderUpload
	})

	if err := runUpload(nil, []string{filePath}); err != nil {
		t.Fatalf("runUpload returned error: %v", err)
	}
}

func TestRunUploadRejectsOversizedDirectoryBeforeRequest(t *testing.T) {
	sourceDir := t.TempDir()
	largePath := filepath.Join(sourceDir, "large.bin")
	f, err := os.Create(largePath)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := f.Truncate(200*1024*1024 + 1); err != nil {
		t.Fatalf("Truncate: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	requestHit := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestHit = true
		t.Fatalf("upload server should not receive oversized folder request")
	}))
	defer server.Close()

	writeUploadConfig(t, server.URL, "secret")
	previousFolderUpload := folderUpload
	folderUpload = true
	t.Cleanup(func() {
		folderUpload = previousFolderUpload
	})

	err = runUpload(nil, []string{sourceDir})
	if err == nil {
		t.Fatal("runUpload returned nil error")
	}
	if requestHit {
		t.Fatal("upload request was sent for oversized folder")
	}
	if !strings.Contains(err.Error(), "exceeds limit 200 MiB") {
		t.Fatalf("error = %q, want 200 MiB size limit", err.Error())
	}
}

func TestRunUploadRecordsHistory(t *testing.T) {
	sourceDir := t.TempDir()
	filePath := filepath.Join(sourceDir, "notes.md")
	if err := os.WriteFile(filePath, []byte("# Notes\n"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"url":"https://example.test/notes","id":"notes"}`))
	}))
	defer server.Close()

	home := writeUploadConfigWithHome(t, server.URL, "secret")
	previousDocName := docName
	previousFolderUpload := folderUpload
	docName = "Project Notes"
	folderUpload = false
	t.Cleanup(func() {
		docName = previousDocName
		folderUpload = previousFolderUpload
	})

	if err := runUpload(nil, []string{filePath}); err != nil {
		t.Fatalf("runUpload returned error: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(home, ".config", "docs", "uploads.json"))
	if err != nil {
		t.Fatalf("ReadFile uploads.json: %v", err)
	}
	var entries []struct {
		Name string `json:"name"`
		URL  string `json:"url"`
		ID   string `json:"id"`
		Path string `json:"path"`
	}
	if err := json.Unmarshal(data, &entries); err != nil {
		t.Fatalf("Unmarshal uploads.json: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("len(entries) = %d, want 1", len(entries))
	}
	if entries[0].Name != "Project Notes" || entries[0].URL != "https://example.test/notes" || entries[0].ID != "notes" || entries[0].Path != filePath {
		t.Fatalf("entry = %+v, want recorded upload", entries[0])
	}
}

func readUploadZipEntries(t *testing.T, body []byte) map[string]string {
	t.Helper()
	reader, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
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

func writeUploadConfig(t *testing.T, url string, token string) {
	t.Helper()
	_ = writeUploadConfigWithHome(t, url, token)
}

func writeUploadConfigWithHome(t *testing.T, url string, token string) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	configDir := filepath.Join(home, ".config", "docs")
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		t.Fatalf("MkdirAll(%q): %v", configDir, err)
	}
	config := "url: " + url + "\n" + "token: " + token + "\n"
	if err := os.WriteFile(filepath.Join(configDir, "config.yaml"), []byte(config), 0o600); err != nil {
		t.Fatalf("WriteFile config: %v", err)
	}
	return home
}

func writeUploadTestFile(t *testing.T, path string, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll(%q): %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatalf("WriteFile(%q): %v", path, err)
	}
}
