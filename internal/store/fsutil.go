// File-system helpers: atomic writes, keeping broken files aside, logging.
package store

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// quarantine moves aside a file that exists but can't be parsed, so the
// fresh copy written in its place never destroys what was in it. Every file
// MotherGoose reads follows this rule; a file that can't be read at all
// (permissions, disk errors) is an error instead and is left alone.
func quarantine(p string, cause error) error {
	stamp := time.Now().Format("20060102-150405")
	bak := p + ".corrupt-" + stamp
	for i := 2; ; i++ {
		if _, err := os.Lstat(bak); errors.Is(err, os.ErrNotExist) {
			break
		}
		bak = fmt.Sprintf("%s.corrupt-%s-%d", p, stamp, i)
	}
	if err := os.Rename(p, bak); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil // another request already moved it aside
		}
		return fmt.Errorf("%s can't be read (%v) and couldn't be moved aside: %w", p, cause, err)
	}
	log.Printf("%s could not be read (%v); kept it as %s and started fresh", p, cause, filepath.Base(bak))
	return nil
}

var (
	loggedMu sync.Mutex
	logged   = map[string]bool{}
)

// logOnce logs a problem the first time it is seen, for problems that would
// otherwise be logged again on every refresh.
func logOnce(key, format string, args ...any) {
	loggedMu.Lock()
	seen := logged[key]
	logged[key] = true
	loggedMu.Unlock()
	if !seen {
		log.Printf(format, args...)
	}
}

// fileMode is used for every file MotherGoose writes. The data folder is
// meant to be browsed and edited by hand, so files are readable like ones the
// user saved themselves (os.CreateTemp alone would leave them owner-only).
const fileMode = 0o644

// writeAtomic replaces p with b through a temp file in the same folder. The
// temp file is flushed to disk before it is renamed over p, and the rename is
// flushed after, so after a crash or power cut p holds either the old contents
// or the new ones, never a mix or an empty file.
func writeAtomic(p string, b []byte) error { return writeAtomicFrom(p, bytes.NewReader(b)) }

// writeAtomicFrom is writeAtomic for a stream. If reading r fails, p is left
// untouched.
func writeAtomicFrom(p string, r io.Reader) error {
	dir := filepath.Dir(p)
	f, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	fail := func(err error) error {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if _, err := io.Copy(f, r); err != nil {
		return fail(err)
	}
	if err := f.Chmod(fileMode); err != nil {
		return fail(err)
	}
	if err := f.Sync(); err != nil {
		return fail(err)
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, p); err != nil {
		os.Remove(tmp)
		return err
	}
	syncDir(dir)
	return nil
}

// syncDir makes a rename in dir durable. Windows can't sync a folder handle
// (NTFS journals the rename itself), so errors here are deliberately ignored.
func syncDir(dir string) {
	d, err := os.Open(dir)
	if err != nil {
		return
	}
	_ = d.Sync()
	d.Close()
}
