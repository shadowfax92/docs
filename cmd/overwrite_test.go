package cmd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/shadowfax/docs/internal/history"
	"github.com/shadowfax/docs/internal/upload"
	"github.com/spf13/cobra"
)

func TestUploadOverwriteKeepsOriginalLink(t *testing.T) {
	stubUploadClipboard(t)
	source := filepath.Join(t.TempDir(), "report.html")
	writeUploadTestFile(t, source, "original")
	version := strings.Repeat("a", 64)
	var mu sync.Mutex
	created := 0
	content := map[string]string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.Method == http.MethodGet && !strings.HasPrefix(r.URL.Path, "/upload/") {
			fmt.Fprint(w, content[strings.TrimPrefix(r.URL.Path, "/")])
			return
		}
		if r.Header.Get("Authorization") != "Bearer fixture" {
			t.Error("mutation route received an unexpected Authorization header")
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		id := strings.TrimPrefix(r.URL.Path, "/upload/")
		switch {
		case r.Method == http.MethodPut && r.URL.Path == "/upload":
			created++
			id = fmt.Sprintf("Doc%05d", created)
		case r.Method == http.MethodGet && id == "Doc00001":
		case r.Method == http.MethodPut && id == "Doc00001":
			if r.Header.Get("If-Match") != `"`+version+`"` || r.Header.Get("X-Doc-Name") != "" {
				t.Error("overwrite must use the current version and preserve the title by default")
				w.WriteHeader(http.StatusPreconditionFailed)
				return
			}
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		if r.Method == http.MethodPut {
			body, err := io.ReadAll(r.Body)
			if err != nil {
				t.Error(err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			content[id] = string(body)
		}
		_ = json.NewEncoder(w).Encode(upload.Response{
			ID: id, URL: "http://" + r.Host + "/" + id, Name: "Report", Version: version,
		})
	}))
	defer server.Close()
	home := writeUploadConfigWithHome(t, server.URL, "fixture")
	store := appendDeleteHistory(t, home, history.Entry{
		URL: "https://other.example/Doc00001", Path: source,
	})

	first, err := executeDocsCLI(t, "upload", source)
	if err != nil || first != server.URL+"/Doc00001\n" {
		t.Fatalf("fresh upload = %q, %v", first, err)
	}
	// Older history records can omit IDs. Duplicate rows for the same URL are one target.
	if err := store.Append(history.Entry{URL: strings.TrimSpace(first), Path: source}); err != nil {
		t.Fatal(err)
	}
	writeUploadTestFile(t, source, "revised")
	result, err := executeDocsCLI(t, "upload", "--overwrite", source)
	if err != nil || result != first {
		t.Fatalf("overwrite = %q, %v; want original URL %q", result, err, first)
	}
	resp, err := server.Client().Get(strings.TrimSpace(first))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil || resp.StatusCode != http.StatusOK || string(body) != "revised" {
		t.Fatalf("original link served %d %q, %v", resp.StatusCode, body, err)
	}
	second, err := executeDocsCLI(t, "upload", source)
	if err != nil || second != server.URL+"/Doc00002\n" {
		t.Fatalf("fresh re-upload = %q, %v", second, err)
	}
}

func TestUploadOverwriteRequiresOneRecordedTarget(t *testing.T) {
	for _, tc := range []struct {
		name string
		ids  []string
		want string
	}{
		{name: "missing history", want: "no upload recorded"},
		{name: "ambiguous path", ids: []string{"Doc00001", "Doc00002"}, want: "multiple uploads recorded"},
		{name: "remote target deleted", ids: []string{"Doc00001"}, want: "upload not found"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			source := filepath.Join(t.TempDir(), "report.html")
			writeUploadTestFile(t, source, "revised")
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if len(tc.ids) != 1 || r.Method != http.MethodGet || r.URL.Path != "/upload/Doc00001" {
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
				}
				w.Header().Set("X-Docs-Update-Result", "not-found")
				http.NotFound(w, r)
			}))
			defer server.Close()
			home := writeUploadConfigWithHome(t, server.URL, "fixture")
			for _, id := range tc.ids {
				appendDeleteHistory(t, home, history.Entry{URL: server.URL + "/" + id, ID: id, Path: source})
			}
			out, err := executeDocsCLI(t, "upload", source, "--overwrite")
			if err == nil || !strings.Contains(err.Error(), tc.want) || out != "" {
				t.Fatalf("overwrite = %q, %v; want no URL and %q error", out, err, tc.want)
			}
		})
	}
}

func TestSkillAndHelpWithoutConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	for _, tc := range []struct {
		args []string
		want []string
	}{
		{args: []string{"--skill"}, want: []string{"docs upload ./report.html", "docs upload --overwrite", "docs update <id-or-url>", "revised content"}},
		{args: []string{"--help"}, want: []string{"--skill", "print the agent usage guide"}},
		{args: []string{"upload", "--help"}, want: []string{"--overwrite", "docs update <id-or-url>"}},
	} {
		out, err := executeDocsCLI(t, tc.args...)
		if err != nil {
			t.Fatal(err)
		}
		for _, want := range tc.want {
			if !strings.Contains(out, want) {
				t.Errorf("docs %v missing %q in %q", tc.args, want, out)
			}
		}
	}
	entries, err := os.ReadDir(home)
	if err != nil || len(entries) != 0 {
		t.Fatalf("guide or help changed the local home: %v, %v", entries, err)
	}
}

// Cobra's package-level commands are normally executed once per process.
// Restore the flags touched by these CLI tests between invocations.
func executeDocsCLI(t *testing.T, args ...string) (string, error) {
	t.Helper()
	var out bytes.Buffer
	rootCmd.SetArgs(args)
	rootCmd.SetOut(&out)
	rootCmd.SetErr(io.Discard)
	defer func() {
		rootCmd.SetArgs(nil)
		rootCmd.SetOut(nil)
		rootCmd.SetErr(nil)
		for _, command := range []*cobra.Command{rootCmd, uploadCmd} {
			for _, name := range []string{"skill", "overwrite", "help"} {
				if flag := command.Flags().Lookup(name); flag != nil {
					if err := flag.Value.Set(flag.DefValue); err != nil {
						t.Error(err)
					}
					flag.Changed = false
				}
			}
		}
	}()
	err := Execute()
	return out.String(), err
}

func stubUploadClipboard(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	for _, name := range []string{"pbcopy", "xclip"} {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte("#!/bin/sh\nexec /bin/cat >/dev/null\n"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}
