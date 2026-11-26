package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/shadowfax/docs/internal/config"
	"github.com/shadowfax/docs/internal/history"
	"github.com/shadowfax/docs/internal/upload"
)

var updateName string
var updateFolder bool
var updateJSON bool

type updateOptions struct {
	folder bool
	name   string
	json   bool
}

// updateCmd explicitly targets a published identity. Optional source reuse comes only from local
// history for that exact public URL; it never guesses which remote upload belongs to a filename.
var updateCmd = &cobra.Command{
	Use:     "update <id-or-url> [file-or-folder]",
	Aliases: []string{"reupload"},
	Short:   "Replace an upload's content, keeping its URL",
	Long: `Update an existing upload without changing its short URL.

Accepts an upload ID or a full URL from the configured Worker. Omit the source
to reuse the absolute path recorded in local history. Use --folder to publish a
folder as a zip.
The existing title is preserved unless --name is supplied. Concurrent changes
cause an error; missing uploads never create a new link, and their local history
entries are removed. Prints the same URL without changing the clipboard. Reload
an open browser tab to see new content.`,
	Example: `  docs update vPNW0l6j ./report.html
  docs update https://docs.shadowfax92.workers.dev/vPNW0l6j ./report.html
  docs update vPNW0l6j
  docs reupload vPNW0l6j ./report.html --name "Revised report"
  docs update Ab12Cd34 ./guides --folder --json`,
	Args: cobra.RangeArgs(1, 2),
	RunE: runUpdate,
}

func init() {
	updateCmd.Flags().StringVarP(&updateName, "name", "n", "", "replace the link preview title (default: preserve existing title)")
	updateCmd.Flags().BoolVar(&updateFolder, "folder", false, "recursively archive a folder before updating")
	updateCmd.Flags().BoolVar(&updateJSON, "json", false, "print the updated URL, ID, title and version as JSON")
	rootCmd.AddCommand(updateCmd)
}

func runUpdate(cmd *cobra.Command, args []string) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	id, err := upload.TargetID(cfg, args[0])
	if err != nil {
		return err
	}
	filePath := ""
	rememberedFolder := false
	if len(args) == 2 {
		filePath = args[1]
	} else {
		var source history.Entry
		source, err = rememberedSource(cfg, id)
		if err != nil {
			return err
		}
		filePath, rememberedFolder = source.Path, source.Folder
	}
	return updatePath(cmd, cfg, id, filePath, updateOptions{
		folder: updateFolder || rememberedFolder,
		name:   updateName,
		json:   updateJSON,
	})
}

// updatePath publishes to a resolved upload ID and records the source only
// after the Worker confirms the new revision at the same URL.
func updatePath(cmd *cobra.Command, cfg *config.Config, id, filePath string, opts updateOptions) error {
	info, err := os.Stat(filePath)
	if err != nil {
		return fmt.Errorf("cannot access source %s: %w; pass its current path: docs update %s <file>", filePath, err, id)
	}
	// Remembered folders are already known publication sources; explicit directories retain
	// upload's --folder guard so a mistyped path cannot accidentally publish a whole directory.
	if info.IsDir() && !opts.folder {
		return fmt.Errorf("%s is a directory; pass --folder to update it as a zip archive", filePath)
	}
	if !info.IsDir() && opts.folder {
		return fmt.Errorf("--folder requires a directory")
	}
	if !info.IsDir() && !info.Mode().IsRegular() {
		return fmt.Errorf("%s is not a regular file", filePath)
	}
	if cmd.Flags().Changed("name") && opts.name == "" {
		return fmt.Errorf("--name must not be empty")
	}
	if !opts.json {
		fmt.Fprintf(cmd.ErrOrStderr(), "Updating %s from %s...\n", id, filePath)
	}
	publish := func(source string) (*upload.Response, error) { return upload.Update(cfg, id, source, opts.name) }
	var response *upload.Response
	if info.IsDir() {
		response, err = withFolderArchive(filePath, publish)
	} else {
		response, err = publish(filePath)
	}
	if errors.Is(err, upload.ErrNotFound) {
		// Same authority as docs delete: a marked absence is definitive, so forget this exact URL.
		// Otherwise a fresh upload of the same source would leave --overwrite ambiguous forever.
		store, storeErr := history.NewDefaultStore()
		removed := 0
		if storeErr == nil {
			removed, storeErr = store.RemoveByURL(strings.TrimRight(cfg.URL, "/") + "/" + id)
		}
		if storeErr != nil {
			return deleteHistoryError(id, false, storeErr)
		}
		fmt.Fprintln(cmd.ErrOrStderr(), missingMessage(id, removed))
		return err
	}
	if err != nil {
		return err
	}
	if opts.json {
		err = json.NewEncoder(cmd.OutOrStdout()).Encode(response)
	} else {
		_, err = fmt.Fprintln(cmd.OutOrStdout(), response.URL)
	}
	if err != nil {
		return fmt.Errorf("updated %s, but could not print the result: %w", response.URL, err)
	}
	absolutePath, pathErr := filepath.Abs(filePath)
	store, storeErr := history.NewDefaultStore()
	if pathErr == nil && storeErr == nil {
		storeErr = store.Upsert(history.Entry{UploadedAt: time.Now().UTC(), Name: response.Name,
			URL: response.URL, ID: response.ID, Path: absolutePath, Folder: info.IsDir()})
	}
	if pathErr != nil || storeErr != nil {
		fmt.Fprintln(cmd.ErrOrStderr(), "Updated remotely, but could not save local history; pass the source path on the next update")
	}
	if !opts.json {
		fmt.Fprintln(cmd.ErrOrStderr(), "Updated in place; URL unchanged")
	}
	return nil
}

func rememberedSource(cfg *config.Config, id string) (history.Entry, error) {
	store, err := history.NewDefaultStore()
	if err != nil {
		return history.Entry{}, err
	}
	entries, err := store.List(history.Filter{})
	if err != nil {
		return history.Entry{}, fmt.Errorf("cannot read local source history: %w; pass a source path explicitly", err)
	}
	url := strings.TrimRight(cfg.URL, "/") + "/" + id
	// Older CLIs recorded paths as typed. A relative path names a different file from any other
	// directory, so only an absolute recorded path identifies the source that was published.
	for _, entry := range entries {
		if entry.URL == url && filepath.IsAbs(entry.Path) {
			return entry, nil
		}
	}
	return history.Entry{}, fmt.Errorf("no absolute source path recorded for %s; pass a file: docs update %s <file>", id, id)
}
