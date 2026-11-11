package upload

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/shadowfax/docs/internal/config"
)

var uploadID = regexp.MustCompile(`^[A-Za-z0-9]{8}$`)
var uploadVersion = regexp.MustCompile(`^[a-f0-9]{64}$`)

// TargetID accepts copied public links without ever sending credentials to their origin.
// All requests still use the configured Worker; a foreign link is rejected before any network I/O.
func TargetID(cfg *config.Config, target string) (string, error) {
	if uploadID.MatchString(target) {
		return target, nil
	}
	base, err := url.Parse(strings.TrimRight(cfg.URL, "/"))
	if err != nil || base.Host == "" || (base.Scheme != "https" && base.Scheme != "http") {
		return "", fmt.Errorf("invalid configured Worker URL; run 'docs config'")
	}
	link, err := url.Parse(target)
	if err != nil || link.Host != base.Host || link.Scheme != base.Scheme || link.User != nil {
		return "", fmt.Errorf("expected an 8-character upload ID or a URL from %s", base.Redacted())
	}
	id := strings.TrimSuffix(strings.TrimPrefix(link.Path, base.Path+"/"), "/")
	if !uploadID.MatchString(id) {
		return "", fmt.Errorf("expected a short document URL such as %s/Ab12Cd34", base.Redacted())
	}
	return id, nil
}

// Inspect freezes the authoritative version before streaming replacement bytes. Its capability
// marker distinguishes a missing upload from an older Worker that cannot update uploads at all.
func Inspect(cfg *config.Config, id string) (*Response, error) {
	if !uploadID.MatchString(id) {
		return nil, fmt.Errorf("invalid upload ID")
	}
	req, err := http.NewRequest(http.MethodGet, strings.TrimRight(cfg.URL, "/")+"/upload/"+id, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("read current upload: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return nil, fmt.Errorf("read current upload response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, updateError(resp.StatusCode, resp.Header.Get("X-Docs-Update-Result"), string(body))
	}
	var result Response
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("invalid current upload response: %w", err)
	}
	if result.ID != id || result.URL != strings.TrimRight(cfg.URL, "/")+"/"+id || !uploadVersion.MatchString(result.Version) {
		return nil, fmt.Errorf("Worker returned an invalid upload identity or version; no update sent")
	}
	return &result, nil
}

// Update publishes a new revision at the existing URL. An empty name preserves the server's
// current title. A lost version race is surfaced to the operator without automatic overwrite.
func Update(cfg *config.Config, id, filePath, docName string) (*Response, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return nil, fmt.Errorf("cannot open file: %w", err)
	}
	defer f.Close()
	filename := filepath.Base(filePath)
	contentType, err := detectContentType(filename, f)
	if err != nil {
		return nil, err
	}
	current, err := Inspect(cfg, id)
	if err != nil {
		return nil, err
	}
	result, err := writeContent(cfg, "/upload/"+id, filename, contentType, f, docName, current.Version)
	if err != nil {
		return nil, err
	}
	if result.ID != current.ID || result.URL != current.URL || !uploadVersion.MatchString(result.Version) {
		return nil, fmt.Errorf("Worker returned an invalid update result; check %s before retrying", current.URL)
	}
	return result, nil
}

func updateError(status int, marker, body string) error {
	switch {
	case status == http.StatusNotFound && marker == "not-found":
		return fmt.Errorf("upload not found; check its ID or URL (use 'docs upload <file>' to create a new link)")
	case status == http.StatusNotFound:
		return fmt.Errorf("Worker does not support updates yet; deploy the latest docs Worker, then retry")
	case status == http.StatusPreconditionFailed || status == http.StatusConflict:
		return fmt.Errorf("upload changed during this update; review the current document and run 'docs update' again")
	default:
		return fmt.Errorf("update failed (HTTP %d): %s", status, strings.TrimSpace(body))
	}
}
