package cmd

import (
	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:          "docs",
	Short:        "Share documents with short URLs",
	Long:         "Upload PDFs, HTML files, Markdown files, and Markdown folders to get a short, shareable URL that renders in the browser.",
	SilenceUsage: true,
}

func Execute() error {
	return rootCmd.Execute()
}
