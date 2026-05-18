package cmd

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunUploadAcceptsMarkdownDirectory(t *testing.T) {
	sourceDir := t.TempDir()
	writeUploadTestFile(t, filepath.Join(sourceDir, "intro.md"), "hello\n")
	writeUploadTestFile(t, filepath.Join(sourceDir, "nested", "guide.md"), "world\n")
	writeUploadTestFile(t, filepath.Join(sourceDir, "nested", "skip.txt"), "ignored\n")

	var uploaded string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Content-Type") != "text/markdown" {
			t.Fatalf("Content-Type = %q, want text/markdown", r.Header.Get("Content-Type"))
		}
		if r.Header.Get("Authorization") != "Bearer secret" {
			t.Fatalf("Authorization = %q, want bearer token", r.Header.Get("Authorization"))
		}
		if r.Header.Get("X-Filename") != filepath.Base(sourceDir)+".md" {
			t.Fatalf("X-Filename = %q, want directory markdown filename", r.Header.Get("X-Filename"))
		}
		if r.Header.Get("X-Doc-Name") != "Folder Docs" {
			t.Fatalf("X-Doc-Name = %q, want Folder Docs", r.Header.Get("X-Doc-Name"))
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("ReadAll: %v", err)
		}
		uploaded = string(body)
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
	if !strings.Contains(uploaded, "- [intro.md](#intro-md)") {
		t.Fatalf("uploaded markdown missing intro TOC link:\n%s", uploaded)
	}
	if !strings.Contains(uploaded, "  - [guide.md](#nested-guide-md)") {
		t.Fatalf("uploaded markdown missing nested guide TOC link:\n%s", uploaded)
	}
	if strings.Contains(uploaded, "ignored") {
		t.Fatalf("uploaded markdown included non-markdown file:\n%s", uploaded)
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
}

func writeUploadConfig(t *testing.T, url string, token string) {
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
