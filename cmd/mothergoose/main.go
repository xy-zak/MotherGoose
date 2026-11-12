// Command mothergoose runs the local D&D session server.
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"mothergoose/internal/server"
	"mothergoose/internal/store"
)

var version = "dev"

func main() {
	port := flag.Int("port", 8080, "port to listen on (tries the next few if busy)")
	dataDir := flag.String("data", "", "data folder (default: \"data\" next to the program)")
	noBrowser := flag.Bool("no-browser", false, "don't open the dashboard in a browser on start")
	flag.Parse()

	if err := run(*port, *dataDir, !*noBrowser); err != nil {
		fmt.Fprintln(os.Stderr, "\nmothergoose:", err)
		if runtime.GOOS == "windows" {
			// Keep a double-clicked console window open long enough to read.
			fmt.Fprintln(os.Stderr, "Press Enter to close.")
			bufio.NewReader(os.Stdin).ReadString('\n')
		}
		os.Exit(1)
	}
}

// defaultDataDir puts data next to the executable so double-clicking works
// regardless of the working directory. `go run` builds into a temp folder,
// so in that case the current directory is used instead.
func defaultDataDir() string {
	exe, err := os.Executable()
	if err == nil {
		if real, err := filepath.EvalSymlinks(exe); err == nil {
			exe = real
		}
		dir := filepath.Dir(exe)
		if !strings.Contains(dir, string(filepath.Separator)+"go-build") {
			return filepath.Join(dir, "data")
		}
	}
	return "data"
}

func listen(port int) (net.Listener, int, error) {
	var lastErr error
	for p := port; p < port+10; p++ {
		ln, err := net.Listen("tcp", fmt.Sprintf(":%d", p))
		if err == nil {
			return ln, p, nil
		}
		lastErr = err
	}
	return nil, 0, fmt.Errorf("no free port between %d and %d: %w", port, port+9, lastErr)
}

func run(port int, dataDir string, openBrowser bool) error {
	if dataDir == "" {
		dataDir = defaultDataDir()
	}
	st, err := store.Open(dataDir)
	if err != nil {
		return fmt.Errorf("opening data folder: %w", err)
	}
	ln, port, err := listen(port)
	if err != nil {
		return err
	}
	srv := server.New(st, port)
	httpSrv := &http.Server{Handler: srv, ReadHeaderTimeout: 10 * time.Second}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go srv.Watch(ctx)

	admin := fmt.Sprintf("http://localhost:%d/admin", port)
	fmt.Printf("\n  MOTHERGOOSE %s\n\n", version)
	fmt.Printf("  Referee (this computer)      %s\n", admin)
	urls := server.LANURLs(port)
	if len(urls) == 0 {
		fmt.Printf("  Players                      no network found - connect to Wi-Fi/LAN\n")
	}
	for i, u := range urls {
		label := "Players (same network)"
		if i > 0 {
			label = ""
		}
		fmt.Printf("  %-28s %s\n", label, u)
	}
	fmt.Printf("\n  Data folder  %s\n", st.Root())
	fmt.Printf("  Press Ctrl+C to stop.\n\n")

	errc := make(chan error, 1)
	go func() { errc <- httpSrv.Serve(ln) }()
	if openBrowser {
		go func() {
			time.Sleep(300 * time.Millisecond)
			_ = server.OpenInOS(admin)
		}()
	}

	select {
	case err := <-errc:
		st.Flush()
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
	}
	fmt.Println("  Saving and shutting down...")
	shutCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shutCtx)
	st.Flush()
	return nil
}
