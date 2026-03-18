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
	"github.com/shadowfax/docs/internal/upload"
)

var docName string

var uploadCmd = &cobra.Command{
	Use:   "upload <file>",
	Short: "Upload a file and get a short URL",
	Args:  cobra.ExactArgs(1),
	RunE:  runUpload,
}

func init() {
	uploadCmd.Flags().StringVarP(&docName, "name", "n", "", "document name shown in link previews")
	rootCmd.AddCommand(uploadCmd)
}

func runUpload(cmd *cobra.Command, args []string) error {
	filePath := args[0]

	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		return fmt.Errorf("file not found: %s", filePath)
	}

	if !upload.IsSupported(filePath) {
		return fmt.Errorf("unsupported file type (supported: pdf, html, md)")
	}

	cfg, err := config.Load()
	if err != nil {
		return err
	}

	color.New(color.FgCyan).Fprintf(os.Stderr, "Uploading %s...\n", filePath)

	resp, err := upload.Upload(cfg, filePath, docName)
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
