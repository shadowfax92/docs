package cmd

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/fatih/color"
	"github.com/spf13/cobra"

	"github.com/shadowfax/docs/internal/config"
	"github.com/shadowfax/docs/internal/folderarchive"
	"github.com/shadowfax/docs/internal/history"
	"github.com/shadowfax/docs/internal/upload"
)

const maxFolderUploadBytes = 200 * 1024 * 1024

var docName string
var folderUpload bool
var overwriteUpload bool

var uploadCmd = &cobra.Command{
	Use:   "upload <file-or-folder>",
	Short: "Upload a file or folder and get a short URL",
	Long: `Upload a file or folder and get a new short URL.

With --overwrite, replace the upload recorded for this exact local source
path on the configured Worker. If the path has no match or matches multiple
URLs, use 'docs update <id-or-url> <file-or-folder>' to choose the target.
Overwrite prints the existing URL and preserves the title unless --name is set.`,
	Args: cobra.ExactArgs(1),
	RunE: runUpload,
	Example: `  docs upload report.html
  docs upload --overwrite report.html
  docs upload --overwrite --folder ./guides`,
}

func init() {
	uploadCmd.Flags().StringVarP(&docName, "name", "n", "", "document name shown in link previews")
	uploadCmd.Flags().BoolVar(&folderUpload, "folder", false, "recursively archive a folder before uploading")
	uploadCmd.Flags().BoolVar(&overwriteUpload, "overwrite", false, "replace the upload uniquely recorded for this source path")
	rootCmd.AddCommand(uploadCmd)
}

func runUpload(cmd *cobra.Command, args []string) error {
	filePath := args[0]
	if overwriteUpload {
		cfg, err := config.Load()
		if err != nil {
			return err
		}
		id, err := recordedUploadTarget(cfg, filePath)
		if err != nil {
			return err
		}
		return updatePath(cmd, cfg, id, filePath, updateOptions{folder: folderUpload, name: docName})
	}

	info, err := os.Stat(filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("file not found: %s", filePath)
		}
		return fmt.Errorf("cannot access %s: %w", filePath, err)
	}

	if info.IsDir() && !folderUpload {
		return fmt.Errorf("%s is a directory; pass --folder to upload it as a zip archive", filePath)
	}
	if !info.IsDir() && folderUpload {
		return fmt.Errorf("--folder requires a directory")
	}
	if !info.IsDir() && !info.Mode().IsRegular() {
		return fmt.Errorf("%s is not a regular file", filePath)
	}

	cfg, err := config.Load()
	if err != nil {
		return err
	}

	color.New(color.FgCyan).Fprintf(os.Stderr, "Uploading %s...\n", filePath)

	resp, err := uploadPath(cfg, filePath, info, docName)
	if err != nil {
		return err
	}

	green := color.New(color.FgGreen, color.Bold)
	green.Fprintln(cmd.OutOrStdout(), resp.URL)

	if err := copyToClipboard(resp.URL); err != nil {
		color.New(color.FgYellow).Fprintln(os.Stderr, "Could not copy to clipboard")
	} else {
		color.New(color.FgHiBlack).Fprintln(os.Stderr, "Copied to clipboard")
	}

	if err := recordUploadHistory(filePath, info, docName, resp); err != nil {
		color.New(color.FgYellow).Fprintln(os.Stderr, "Could not record upload history")
	}

	return nil
}

// recordedUploadTarget reverses the local URL-to-source mapping. A path may have
// several uploads, so use only a unique URL on the configured Worker.
func recordedUploadTarget(cfg *config.Config, filePath string) (string, error) {
	absolutePath, err := filepath.Abs(filePath)
	if err != nil {
		return "", err
	}
	const explicitTarget = "use 'docs update <id-or-url> <file-or-folder>' with the intended target"
	store, err := history.NewDefaultStore()
	if err != nil {
		return "", err
	}
	entries, err := store.List(history.Filter{})
	if err != nil {
		return "", fmt.Errorf("cannot read local upload history: %w; %s", err, explicitTarget)
	}
	base := strings.TrimRight(cfg.URL, "/")
	targetID := ""
	for _, entry := range entries {
		if entry.Path != absolutePath {
			continue
		}
		id, err := upload.TargetID(cfg, entry.URL)
		if err != nil || entry.URL != base+"/"+id {
			continue
		}
		if targetID != "" && targetID != id {
			return "", fmt.Errorf("multiple uploads recorded for %s on %s; %s", absolutePath, base, explicitTarget)
		}
		targetID = id
	}
	if targetID == "" {
		return "", fmt.Errorf("no upload recorded for %s on %s; %s", absolutePath, base, explicitTarget)
	}
	return targetID, nil
}

// uploadPath routes files and folder archives through the shared upload API.
func uploadPath(cfg *config.Config, filePath string, info os.FileInfo, docName string) (*upload.Response, error) {
	if !info.IsDir() {
		return upload.Upload(cfg, filePath, docName)
	}
	return uploadFolder(cfg, filePath, docName)
}

// uploadFolder creates a temporary archive so a directory still fits the one-object upload API.
func uploadFolder(cfg *config.Config, filePath string, docName string) (*upload.Response, error) {
	return withFolderArchive(filePath, func(archivePath string) (*upload.Response, error) {
		return upload.Upload(cfg, archivePath, docName)
	})
}

// withFolderArchive keeps the temporary zip alive until either publication operation finishes.
func withFolderArchive(filePath string, publish func(string) (*upload.Response, error)) (*upload.Response, error) {
	tempDir, err := os.MkdirTemp("", "docs-folder-*")
	if err != nil {
		return nil, fmt.Errorf("create temporary archive directory: %w", err)
	}
	defer os.RemoveAll(tempDir)

	archivePath := filepath.Join(tempDir, folderArchiveFilename(filePath))
	if err := folderarchive.WriteZip(filePath, archivePath, maxFolderUploadBytes); err != nil {
		return nil, err
	}
	return publish(archivePath)
}

func recordUploadHistory(filePath string, info os.FileInfo, docName string, resp *upload.Response) error {
	absolutePath, err := filepath.Abs(filePath)
	if err != nil {
		return err
	}
	store, err := history.NewDefaultStore()
	if err != nil {
		return err
	}
	return store.Append(history.Entry{
		UploadedAt: time.Now().UTC(),
		Name:       uploadHistoryName(filePath, info, docName),
		URL:        resp.URL,
		ID:         resp.ID,
		Path:       absolutePath,
		Folder:     info.IsDir(),
	})
}

func uploadHistoryName(filePath string, info os.FileInfo, docName string) string {
	if docName != "" {
		return docName
	}
	if info.IsDir() {
		return folderArchiveFilename(filePath)
	}
	return filepath.Base(filePath)
}

func folderArchiveFilename(folderPath string) string {
	base := filepath.Base(filepath.Clean(folderPath))
	if base == "." || base == string(filepath.Separator) {
		base = "folder"
	}
	return base + ".zip"
}

func copyToClipboard(text string) error {
	var c *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		c = exec.Command("pbcopy")
	case "linux":
		c = exec.Command("xclip", "-selection", "clipboard")
	default:
		return fmt.Errorf("unsupported platform")
	}
	c.Stdin = strings.NewReader(text)
	return c.Run()
}
