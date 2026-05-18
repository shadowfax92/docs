package upload

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/shadowfax/docs/internal/config"
)

var httpClient = &http.Client{Timeout: 2 * time.Minute}

type Response struct {
	URL string `json:"url"`
	ID  string `json:"id"`
}

var extToContentType = map[string]string{
	".pdf":      "application/pdf",
	".html":     "text/html",
	".htm":      "text/html",
	".md":       "text/markdown",
	".markdown": "text/markdown",
}

func SupportedExtensions() []string {
	return []string{".pdf", ".html", ".htm", ".md", ".markdown"}
}

func IsSupported(filename string) bool {
	ext := strings.ToLower(filepath.Ext(filename))
	_, ok := extToContentType[ext]
	return ok
}

func Upload(cfg *config.Config, filePath string, docName string) (*Response, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return nil, fmt.Errorf("cannot open file: %w", err)
	}
	defer f.Close()

	filename := filepath.Base(filePath)
	ext := strings.ToLower(filepath.Ext(filename))
	contentType, ok := extToContentType[ext]
	if !ok {
		return nil, fmt.Errorf("unsupported file type: %s (supported: pdf, html, md)", ext)
	}

	return UploadContent(cfg, filename, contentType, f, docName)
}

// UploadContent sends an already-prepared document body through the upload API.
func UploadContent(cfg *config.Config, filename string, contentType string, content io.Reader, docName string) (*Response, error) {
	url := strings.TrimRight(cfg.URL, "/") + "/upload"
	req, err := http.NewRequest(http.MethodPut, url, content)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("X-Filename", filename)
	if docName != "" {
		req.Header.Set("X-Doc-Name", docName)
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("upload failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("upload failed (HTTP %d): %s", resp.StatusCode, string(body))
	}

	var result Response
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("invalid response: %w", err)
	}
	return &result, nil
}
