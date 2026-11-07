// Command linearizability checks a history of a key-value store for linearizability, with
// Porcupine v1.3.1 (github.com/anishathalye/porcupine, the MIT License). It reads the history on
// stdin, one JSON line for each operation (see Line), and it prints one JSON line (see Verdict):
//
//	{"client":0,"op":"put","key":"x","value":"1","call":100,"return":250,"result":"ok"}
//	{"client":1,"op":"get","key":"x","value":"1","call":120,"return":300,"result":"ok"}
//	{"client":2,"op":"put","key":"x","value":"2","call":400,"result":"unknown"}
//
//	{"ev":"checked","result":"Ok","operations":3,"keys":1,"illegal":[],"undecided":[],"dropped":0,"unknown":1}
//
// The model is a register for each key, thus the check of each key is apart from the others.
//
// The exit code is 0 for Ok, 1 for Illegal or Unknown, and 2 for a history or an option that the
// program refuses. The program knows nothing of the store that made the history.
//
// The options:
//
//	-timeout   the longest check of one key, 1m by default. 0 has no limit.
//	-visualize a path for the HTML page of Porcupine, for the whole history.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/anishathalye/porcupine"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

// run is the program, with its streams as arguments, thus a test can operate it.
func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("linearizability", flag.ContinueOnError)
	flags.SetOutput(stderr)
	timeout := flags.Duration("timeout", time.Minute, "the longest check of one key; 0 has no limit")
	visualize := flags.String("visualize", "", "a path for the HTML page of Porcupine, for the whole history")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if flags.NArg() > 0 {
		fmt.Fprintf(stderr, "linearizability: the program takes no operand: %v\n", flags.Args())
		return 2
	}
	history, err := Parse(stdin)
	if err != nil {
		fmt.Fprintf(stderr, "linearizability: %v\n", err)
		return 2
	}
	verdict := Check(history, *timeout)
	if *visualize != "" {
		model := modelOf(true)
		_, info := porcupine.CheckOperationsVerbose(model, history.Operations, *timeout)
		if err := porcupine.VisualizePath(model, info, *visualize); err != nil {
			fmt.Fprintf(stderr, "linearizability: %v\n", err)
			return 2
		}
	}
	line, err := json.Marshal(verdict)
	if err != nil {
		fmt.Fprintf(stderr, "linearizability: %v\n", err)
		return 2
	}
	fmt.Fprintln(stdout, string(line))
	if verdict.Result != string(porcupine.Ok) {
		return 1
	}
	return 0
}
