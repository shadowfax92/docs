package upload

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/shadowfax/docs/internal/config"
)

func TestTargetIDAcceptsConfiguredLinksAndRejectsForeignURLs(t *testing.T) {
	cfg := &config.Config{URL: "https://docs.example"}
	for _, target := range []string{"Ab12Cd34", "https://docs.example/Ab12Cd34", "https://docs.example/Ab12Cd34/?view=1#state"} {
		if id, err := TargetID(cfg, target); err != nil || id != "Ab12Cd34" {
			t.Errorf("TargetID(%q) = %q, %v", target, id, err)
		}
	}
	for _, target := range []string{"https://elsewhere.example/Ab12Cd34", "https://docs.example.evil/Ab12Cd34", "http://docs.example/Ab12Cd34", "https://user@docs.example/Ab12Cd34", "https://docs.example/Ab12Cd34/raw", "../Ab12Cd34", "short"} {
		if _, err := TargetID(cfg, target); err == nil {
			t.Errorf("TargetID accepted %q", target)
		}
	}
}

func TestUpdateStreamsReplacementInOneRequestAndPreservesTitle(t *testing.T) {
	for _, contents := range []string{"replacement\r\nbytes 😀", ""} {
		t.Run(contents, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "revised.html")
			if err := os.WriteFile(file, []byte(contents), 0600); err != nil {
				t.Fatal(err)
			}
			requests := []string{}
			version := strings.Repeat("a", 64)
			var server *httptest.Server
			server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests = append(requests, r.Method+" "+r.URL.Path)
				if r.Header.Get("Authorization") != "Bearer fixture-secret" || r.Header.Get("X-Doc-Name") != "" {
					t.Errorf("credential or title preservation headers are wrong")
				}
				body, _ := io.ReadAll(r.Body)
				if string(body) != contents || r.ContentLength != int64(len(contents)) {
					t.Errorf("replacement body or fixed length changed")
				}
				if r.Header.Get("X-Filename") != "revised.html" || r.Header.Get("Content-Type") != "text/html" {
					t.Errorf("replacement filename or type changed")
				}
				_ = json.NewEncoder(w).Encode(Response{ID: "Ab12Cd34", URL: server.URL + "/Ab12Cd34", Name: "Existing title", Version: version})
			}))
			defer server.Close()
			result, err := Update(&config.Config{URL: server.URL, Token: "fixture-secret"}, "Ab12Cd34", file, "")
			if err != nil || result.URL != server.URL+"/Ab12Cd34" || strings.Join(requests, ",") != "PUT /upload/Ab12Cd34" {
				t.Fatalf("Update = %+v, %v; requests %v", result, err, requests)
			}
		})
	}
}

func TestUpdateReportsFailuresWithoutCreatingLinks(t *testing.T) {
	for _, scenario := range []struct {
		name, marker string
		want         []string
		status       int
	}{
		{"old worker", "", []string{"does not support updates"}, 404},
		{"missing upload", "not-found", []string{"upload not found"}, 404},
		{"concurrent edit", "changed", []string{"upload changed"}, 409},
		{"auth failure", "", []string{"HTTP 401"}, 401},
		// A storage error can follow a committed publication, so the revision may already be live.
		{"server error", "", []string{"outcome unknown", "HTTP 500: Storage error", "may already be published", "/Ab12Cd34 before retrying"}, 500},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "source.txt")
			_ = os.WriteFile(file, []byte("new"), 0600)
			requests := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests++
				if r.Method != http.MethodPut || r.URL.Path != "/upload/Ab12Cd34" {
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
				}
				w.Header().Set("X-Docs-Update-Result", scenario.marker)
				w.WriteHeader(scenario.status)
				if scenario.status == 500 {
					_, _ = io.WriteString(w, "Storage error")
				}
			}))
			defer server.Close()
			_, err := Update(&config.Config{URL: server.URL, Token: "fixture"}, "Ab12Cd34", file, "")
			for _, want := range scenario.want {
				if err == nil || !strings.Contains(err.Error(), want) {
					t.Fatalf("Update error = %v; want %q", err, want)
				}
			}
			if requests != 1 {
				t.Fatalf("Update sent %d requests; mutations must not be retried", requests)
			}
		})
	}
}
