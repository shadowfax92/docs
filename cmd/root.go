package cmd

import (
	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:          "docs",
	Short:        "Share files with short URLs",
	Long:         "Upload files and folders to get a short, shareable URL. Renderable documents open in the browser; other files get a download page.",
	SilenceUsage: true,
}

func Execute() error {
	return rootCmd.Execute()
}
