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

const maxFolderUploadBytes int64 = 200 * 1024 * 1024

var docName string
var folderUpload bool

var uploadCmd = &cobra.Command{
	Use:   "upload [--folder] <file-or-folder>",
	Short: "Upload a file or folder and get a short URL",
	Args:  cobra.ExactArgs(1),
	RunE:  runUpload,
}

func init() {
	uploadCmd.Flags().StringVarP(&docName, "name", "n", "", "document name shown in link previews")
	uploadCmd.Flags().BoolVar(&folderUpload, "folder", false, "recursively archive a folder before uploading")
	rootCmd.AddCommand(uploadCmd)
}

func runUpload(cmd *cobra.Command, args []string) error {
	filePath := args[0]

	info, err := os.Stat(filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("file not found: %s", filePath)
		}
		return fmt.Errorf("cannot access %s: %w", filePath, err)
	}

	if info.IsDir() && !folderUpload {
		return fmt.Errorf("%s is a directory; pass --folder to upload it", filePath)
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
	green.Println(resp.URL)

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

// uploadPath routes files and archived directories through the shared upload API.
func uploadPath(cfg *config.Config, filePath string, info os.FileInfo, docName string) (*upload.Response, error) {
	if !info.IsDir() {
		return upload.Upload(cfg, filePath, docName)
	}
	archive, err := folderarchive.New(filePath, maxFolderUploadBytes)
	if err != nil {
		return nil, err
	}
	defer archive.Content.Close()
	return upload.UploadContent(cfg, archive.Filename, "application/zip", archive.Content, docName)
}

func recordUploadHistory(filePath string, info os.FileInfo, docName string, resp *upload.Response) error {
	store, err := history.NewDefaultStore()
	if err != nil {
		return err
	}
	return store.Append(history.Entry{
		UploadedAt: time.Now().UTC(),
		Name:       uploadHistoryName(filePath, info, docName),
		URL:        resp.URL,
		ID:         resp.ID,
		Path:       filePath,
	})
}

func uploadHistoryName(filePath string, info os.FileInfo, docName string) string {
	if docName != "" {
		return docName
	}
	if info.IsDir() {
		return folderarchive.Filename(filePath)
	}
	return filepath.Base(filePath)
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
