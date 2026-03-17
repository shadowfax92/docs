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

var uploadCmd = &cobra.Command{
	Use:   "upload <file>",
	Short: "Upload a file and get a short URL",
	Args:  cobra.ExactArgs(1),
	RunE:  runUpload,
}

func init() {
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

	resp, err := upload.Upload(cfg, filePath)
	if err != nil {
		return err
	}

	copyToClipboard(resp.URL)

	green := color.New(color.FgGreen, color.Bold)
	green.Println(resp.URL)
	color.New(color.FgHiBlack).Fprintln(os.Stderr, "Copied to clipboard")

	return nil
}

func copyToClipboard(text string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("pbcopy")
	case "linux":
		cmd = exec.Command("xclip", "-selection", "clipboard")
	default:
		return
	}
	cmd.Stdin = strings.NewReader(text)
	_ = cmd.Run()
}
