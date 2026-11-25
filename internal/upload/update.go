package upload

import (
	"errors"
	"fmt"
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

// Update publishes a new revision at the existing URL in one request. An empty name preserves
// the server's current title. A lost publication race is surfaced without automatic retry.
func Update(cfg *config.Config, id, filePath, docName string) (*Response, error) {
	if !uploadID.MatchString(id) {
		return nil, fmt.Errorf("invalid upload ID")
	}
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
	result, err := writeContent(cfg, id, filename, contentType, f, docName)
	if err != nil {
		return nil, err
	}
	link := strings.TrimRight(cfg.URL, "/") + "/" + id
	if result.ID != id || result.URL != link || !uploadVersion.MatchString(result.Version) {
		return nil, uncertainUpdate(link, errors.New("Worker returned an invalid update result"))
	}
	return result, nil
}

// uncertainUpdate reports failures after the replacement bytes were sent. The Worker may already
// have published them, so the caller must check the link instead of assuming nothing changed.
func uncertainUpdate(link string, cause error) error {
	return fmt.Errorf("update outcome unknown (%w); it may already be published, so check %s before retrying", cause, link)
}

func updateError(link string, status int, marker, body string) error {
	switch {
	case status == http.StatusNotFound && marker == "not-found":
		return fmt.Errorf("upload not found; check its ID or URL (use 'docs upload <file>' to create a new link)")
	case status == http.StatusNotFound:
		return fmt.Errorf("Worker does not support updates yet; deploy the latest docs Worker, then retry")
	case status == http.StatusConflict:
		return fmt.Errorf("upload changed during this update; review the current document and run 'docs update' again")
	case status >= http.StatusInternalServerError:
		return uncertainUpdate(link, fmt.Errorf("HTTP %d: %s", status, strings.TrimSpace(body)))
	default:
		return fmt.Errorf("update failed (HTTP %d): %s", status, strings.TrimSpace(body))
	}
}
