package cmd

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"

	"github.com/fatih/color"
	"github.com/spf13/cobra"

	"github.com/shadowfax/docs/internal/config"
	"github.com/shadowfax/docs/internal/markdown"
	"github.com/shadowfax/docs/internal/upload"
)

var docName string
var folderUpload bool

var uploadCmd = &cobra.Command{
	Use:   "upload [--folder] <file-or-markdown-folder>",
	Short: "Upload a file or combine a Markdown folder and get a short URL",
	Args:  cobra.ExactArgs(1),
	RunE:  runUpload,
}

func init() {
	uploadCmd.Flags().StringVarP(&docName, "name", "n", "", "document name shown in link previews")
	uploadCmd.Flags().BoolVar(&folderUpload, "folder", false, "recursively combine a Markdown folder before uploading")
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
		return fmt.Errorf("%s is a directory; pass --folder to combine markdown files", filePath)
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

	return nil
}

// uploadPath routes files and Markdown directories through the shared upload API.
func uploadPath(cfg *config.Config, filePath string, info os.FileInfo, docName string) (*upload.Response, error) {
	if !info.IsDir() {
		return upload.Upload(cfg, filePath, docName)
	}
	combined, err := markdown.CombineDirectory(filePath)
	if err != nil {
		return nil, err
	}
	filename := markdown.CombinedFilename(filePath)
	return upload.UploadContent(cfg, filename, "text/markdown", strings.NewReader(combined), docName)
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
