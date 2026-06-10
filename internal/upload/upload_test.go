package upload

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/shadowfax/docs/internal/config"
)

func TestUploadContentSendsMarkdownDocument(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Fatalf("method = %s, want PUT", r.Method)
		}
		if r.URL.Path != "/upload" {
			t.Fatalf("path = %s, want /upload", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer secret" {
			t.Fatalf("Authorization = %q, want bearer token", got)
		}
		if got := r.Header.Get("Content-Type"); got != "text/markdown" {
			t.Fatalf("Content-Type = %q, want text/markdown", got)
		}
		if got := r.Header.Get("X-Filename"); got != "guides.md" {
			t.Fatalf("X-Filename = %q, want guides.md", got)
		}
		if got := r.Header.Get("X-Doc-Name"); got != "Guides" {
			t.Fatalf("X-Doc-Name = %q, want Guides", got)
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("ReadAll: %v", err)
		}
		if string(body) != "# Combined Markdown\n" {
			t.Fatalf("body = %q, want combined markdown", string(body))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"url":"https://example.test/abc123","id":"abc123"}`))
	}))
	defer server.Close()

	cfg := &config.Config{URL: server.URL, Token: "secret"}
	resp, err := UploadContent(cfg, "guides.md", "text/markdown", strings.NewReader("# Combined Markdown\n"), "Guides")
	if err != nil {
		t.Fatalf("UploadContent returned error: %v", err)
	}
	if resp.URL != "https://example.test/abc123" || resp.ID != "abc123" {
		t.Fatalf("response = %+v, want parsed URL and ID", resp)
	}
}

func TestUploadSendsArbitraryFileWithDetectedContentType(t *testing.T) {
	sourceDir := t.TempDir()
	filePath := filepath.Join(sourceDir, "archive.unknown")
	if err := os.WriteFile(filePath, []byte{0, 1, 2, 3, 4}, 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Content-Type"); got != "application/octet-stream" {
			t.Fatalf("Content-Type = %q, want application/octet-stream", got)
		}
		if got := r.Header.Get("X-Filename"); got != "archive.unknown" {
			t.Fatalf("X-Filename = %q, want archive.unknown", got)
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

	cfg := &config.Config{URL: server.URL, Token: "secret"}
	resp, err := Upload(cfg, filePath, "")
	if err != nil {
		t.Fatalf("Upload returned error: %v", err)
	}
	if resp.URL != "https://example.test/file" || resp.ID != "file" {
		t.Fatalf("response = %+v, want parsed URL and ID", resp)
	}
}

func TestUploadSendsZipWithApplicationZipContentType(t *testing.T) {
	sourceDir := t.TempDir()
	filePath := filepath.Join(sourceDir, "folder.zip")
	if err := os.WriteFile(filePath, []byte("zip bytes"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Content-Type"); got != "application/zip" {
			t.Fatalf("Content-Type = %q, want application/zip", got)
		}
		if got := r.Header.Get("X-Filename"); got != "folder.zip" {
			t.Fatalf("X-Filename = %q, want folder.zip", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"url":"https://example.test/folder","id":"folder"}`))
	}))
	defer server.Close()

	cfg := &config.Config{URL: server.URL, Token: "secret"}
	resp, err := Upload(cfg, filePath, "")
	if err != nil {
		t.Fatalf("Upload returned error: %v", err)
	}
	if resp.URL != "https://example.test/folder" || resp.ID != "folder" {
		t.Fatalf("response = %+v, want parsed URL and ID", resp)
	}
}
