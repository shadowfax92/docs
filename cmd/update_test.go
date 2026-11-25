package cmd

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/shadowfax/docs/internal/history"
	"github.com/shadowfax/docs/internal/upload"
	"github.com/spf13/cobra"
)

func TestUpdateCommandAndReuploadAliasAreDiscoverable(t *testing.T) {
	for _, name := range []string{"update", "reupload"} {
		found, _, err := rootCmd.Find([]string{name})
		if err != nil || found != updateCmd {
			t.Fatalf("Find %s = %v, %v", name, found, err)
		}
	}
	if updateCmd.Args(updateCmd, nil) == nil || updateCmd.Args(updateCmd, []string{"id", "file", "extra"}) == nil {
		t.Fatal("update accepted missing target or extra arguments")
	}
}

func TestRunUpdateReusesSourceAndReplacesHistoryWithoutTouchingOtherWorkers(t *testing.T) {
	file := filepath.Join(t.TempDir(), "updated.html")
	writeUploadTestFile(t, file, "revised content")
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut {
			body, _ := io.ReadAll(r.Body)
			if string(body) != "revised content" {
				t.Errorf("body = %q", body)
			}
		}
		_ = json.NewEncoder(w).Encode(upload.Response{URL: server.URL + "/Ab12Cd34", ID: "Ab12Cd34", Name: "Existing title", Version: strings.Repeat("a", 64)})
	}))
	defer server.Close()
	home := writeUploadConfigWithHome(t, server.URL, "fixture")
	store := appendDeleteHistory(t, home,
		history.Entry{URL: server.URL + "/Ab12Cd34", ID: "Ab12Cd34", Path: file, Name: "Old title"},
		history.Entry{URL: server.URL + "/Ab12Cd34", ID: "Ab12Cd34", Path: file},
		history.Entry{URL: "https://elsewhere.example/Ab12Cd34", ID: "Ab12Cd34", Path: "/other/source"},
	)
	var out bytes.Buffer
	command := &cobra.Command{}
	command.SetOut(&out)
	command.SetErr(io.Discard)
	if err := runUpdate(command, []string{server.URL + "/Ab12Cd34"}); err != nil {
		t.Fatal(err)
	}
	if out.String() != server.URL+"/Ab12Cd34\n" {
		t.Fatalf("output = %q", out.String())
	}
	entries, err := store.List(history.Filter{})
	if err != nil || len(entries) != 2 {
		t.Fatalf("history = %+v, %v", entries, err)
	}
	if entries[0].Name != "Existing title" || entries[0].Path != file || entries[1].URL != "https://elsewhere.example/Ab12Cd34" {
		t.Fatalf("history changed unrelated Worker or lost current source: %+v", entries)
	}
}

func TestRunUpdatePublishesFolderAndReturnsJSON(t *testing.T) {
	folder := t.TempDir()
	writeUploadTestFile(t, filepath.Join(folder, "note.md"), "folder revision")
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut {
			body, _ := io.ReadAll(r.Body)
			assertZipEntries(t, body, map[string]string{"note.md": "folder revision"})
			if r.Header.Get("Content-Type") != "application/zip" || r.Header.Get("X-Doc-Name") != "Revised folder" {
				t.Error("folder metadata changed")
			}
		}
		_ = json.NewEncoder(w).Encode(upload.Response{URL: server.URL + "/Ab12Cd34", ID: "Ab12Cd34", Name: "Revised folder", Version: strings.Repeat("a", 64)})
	}))
	defer server.Close()
	writeUploadConfig(t, server.URL, "fixture")
	previousName, previousFolder, previousJSON := updateName, updateFolder, updateJSON
	updateName, updateFolder, updateJSON = "Revised folder", true, true
	t.Cleanup(func() { updateName, updateFolder, updateJSON = previousName, previousFolder, previousJSON })
	var out bytes.Buffer
	command := &cobra.Command{}
	command.SetOut(&out)
	if err := runUpdate(command, []string{"Ab12Cd34", folder}); err != nil {
		t.Fatal(err)
	}
	var result upload.Response
	if err := json.Unmarshal(out.Bytes(), &result); err != nil || result.ID != "Ab12Cd34" {
		t.Fatalf("JSON result = %s, %v", out.String(), err)
	}
	// A later invocation can reuse the recorded folder without --folder or a source argument.
	updateFolder = false
	out.Reset()
	if err := runUpdate(command, []string{"Ab12Cd34"}); err != nil {
		t.Fatal(err)
	}
}

// Only the Worker's marked not-found proves absence. Every other failure leaves local history
// untouched, because the link may still exist (or the update may even have been published).
func TestRunUpdateFailureLeavesHistoryAndDoesNotPrintSuccess(t *testing.T) {
	for _, tc := range []struct {
		name, marker string
		status       int
		unreachable  bool
	}{
		{name: "auth failure", status: http.StatusUnauthorized},
		{name: "unmarked 404 from an older Worker", status: http.StatusNotFound},
		{name: "concurrent change", marker: "changed", status: http.StatusConflict},
		{name: "storage error", status: http.StatusInternalServerError},
		{name: "transport failure", unreachable: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "source.html")
			writeUploadTestFile(t, file, "content")
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("X-Docs-Update-Result", tc.marker)
				w.WriteHeader(tc.status)
			}))
			defer server.Close()
			home := writeUploadConfigWithHome(t, server.URL, "fixture")
			if tc.unreachable {
				server.Close()
			}
			store := appendDeleteHistory(t, home, history.Entry{ID: "Ab12Cd34", URL: server.URL + "/Ab12Cd34", Path: file})
			before, _ := os.ReadFile(filepath.Join(home, ".config", "docs", "uploads.json"))
			var out bytes.Buffer
			command := &cobra.Command{}
			command.SetOut(&out)
			command.SetErr(io.Discard)
			if err := runUpdate(command, []string{"Ab12Cd34", file}); err == nil {
				t.Fatal("update unexpectedly succeeded")
			}
			after, _ := os.ReadFile(filepath.Join(home, ".config", "docs", "uploads.json"))
			if !bytes.Equal(before, after) || out.Len() != 0 {
				t.Fatal("failed update changed history or advertised success")
			}
			assertDeleteHistoryIDs(t, store, []string{"Ab12Cd34"})
		})
	}
}

// Older CLIs stored paths as typed. Updating from another directory must not publish whatever
// file happens to share that relative name; the caller has to name the source explicitly.
func TestRunUpdateRefusesRelativeRememberedSource(t *testing.T) {
	elsewhere := t.TempDir()
	writeUploadTestFile(t, filepath.Join(elsewhere, "index.html"), "unrelated file in the current directory")
	previous, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(elsewhere); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(previous) })
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("update sent %s %s for an unverifiable source", r.Method, r.URL.Path)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()
	home := writeUploadConfigWithHome(t, server.URL, "fixture")
	appendDeleteHistory(t, home, history.Entry{URL: server.URL + "/Ab12Cd34", ID: "Ab12Cd34", Path: "index.html"})
	before, _ := os.ReadFile(filepath.Join(home, ".config", "docs", "uploads.json"))
	var out bytes.Buffer
	command := &cobra.Command{}
	command.SetOut(&out)
	command.SetErr(io.Discard)
	err = runUpdate(command, []string{"Ab12Cd34"})
	if err == nil || !strings.Contains(err.Error(), "docs update Ab12Cd34 <file>") || out.Len() != 0 {
		t.Fatalf("runUpdate = %v, output %q; want refusal asking for an explicit source", err, out.String())
	}
	after, _ := os.ReadFile(filepath.Join(home, ".config", "docs", "uploads.json"))
	if !bytes.Equal(before, after) {
		t.Fatal("refused update changed history")
	}
}
