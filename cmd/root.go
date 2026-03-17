package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:   "docs",
	Short: "Share documents with short URLs",
	Long:  "Upload PDFs, HTML, and Markdown files to get a short, shareable URL that renders in the browser.",
}

func Execute() error {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return err
	}
	return nil
}
