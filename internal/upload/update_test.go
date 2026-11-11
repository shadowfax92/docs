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

func TestUpdateStreamsReplacementWithFrozenVersionAndPreservesTitle(t *testing.T) {
	for _, contents := range []string{"replacement\r\nbytes 😀", ""} {
		t.Run(contents, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "revised.html")
			if err := os.WriteFile(file, []byte(contents), 0600); err != nil {
				t.Fatal(err)
			}
			methods := []string{}
			version := strings.Repeat("a", 64)
			var server *httptest.Server
			server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				methods = append(methods, r.Method)
				if r.URL.Path != "/upload/Ab12Cd34" || r.Header.Get("Authorization") != "Bearer fixture-secret" {
					t.Errorf("unexpected update request: %s %s", r.Method, r.URL.Path)
				}
				if r.Method == http.MethodPut {
					if r.Header.Get("If-Match") != `"`+version+`"` || r.Header.Get("X-Doc-Name") != "" {
						t.Errorf("version or title preservation headers are wrong")
					}
					body, _ := io.ReadAll(r.Body)
					if string(body) != contents || r.ContentLength != int64(len(contents)) {
						t.Errorf("replacement body or fixed length changed")
					}
					if r.Header.Get("X-Filename") != "revised.html" || r.Header.Get("Content-Type") != "text/html" {
						t.Errorf("replacement filename or type changed")
					}
				}
				_ = json.NewEncoder(w).Encode(Response{ID: "Ab12Cd34", URL: server.URL + "/Ab12Cd34", Name: "Existing title", Version: version})
			}))
			defer server.Close()
			result, err := Update(&config.Config{URL: server.URL, Token: "fixture-secret"}, "Ab12Cd34", file, "")
			if err != nil || result.URL != server.URL+"/Ab12Cd34" || strings.Join(methods, ",") != "GET,PUT" {
				t.Fatalf("Update = %+v, %v; methods %v", result, err, methods)
			}
		})
	}
}

func TestUpdateReportsMissingCapabilityAndConcurrentEditsWithoutCreatingLinks(t *testing.T) {
	for _, scenario := range []struct {
		name, marker, want string
		status             int
	}{
		{"old worker", "", "does not support updates", 404},
		{"missing upload", "not-found", "upload not found", 404},
		{"concurrent edit", "changed", "upload changed", 412},
		{"auth failure", "", "HTTP 401", 401},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "source.txt")
			_ = os.WriteFile(file, []byte("new"), 0600)
			var server *httptest.Server
			server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/upload" {
					t.Error("update attempted to mint a new link")
				}
				if scenario.status == 412 && r.Method == http.MethodGet {
					_ = json.NewEncoder(w).Encode(Response{ID: "Ab12Cd34", URL: server.URL + "/Ab12Cd34", Version: strings.Repeat("a", 64)})
					return
				}
				w.Header().Set("X-Docs-Update-Result", scenario.marker)
				w.WriteHeader(scenario.status)
			}))
			defer server.Close()
			_, err := Update(&config.Config{URL: server.URL, Token: "fixture"}, "Ab12Cd34", file, "")
			if err == nil || !strings.Contains(err.Error(), scenario.want) {
				t.Fatalf("Update error = %v; want %q", err, scenario.want)
			}
		})
	}
}
