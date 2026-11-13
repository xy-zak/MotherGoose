// Page kinds: what a file is, how big it may be, and whether it keeps entries.
package store

import (
	"bytes"
	"fmt"
	"path/filepath"
	"strings"
)

// Kind is what sort of page a file is, decided by its extension.
type Kind string

// KindOf reports the kind of a file name, and whether it's one MotherGoose takes.
func KindOf(name string) (Kind, bool) {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".html", ".htm":
		return KindHTML, true
	case ".pdf":
		return KindPDF, true
	case ".png", ".jpg", ".jpeg":
		return KindImage, true
	}
	return "", false
}

// MaxSize is the largest file of each kind that can be added.
func MaxSize(k Kind) int64 {
	if k == KindPDF {
		return 100 << 20 // rulebooks and scanned maps get big
	}
	return 32 << 20
}

// ContentType is the media type a file is served with.
func ContentType(name string) string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".pdf":
		return "application/pdf"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	}
	return "text/html; charset=utf-8"
}

// checkContent makes sure a PDF or image really is one, so a file can't
// pretend to be an image to get served under a different type.
func checkContent(name string, k Kind, head []byte) error {
	ok := true
	what := "PDF"
	switch {
	case k == KindPDF:
		ok = bytes.Contains(head, []byte("%PDF-")) // may follow up to 1 KiB of junk
	case strings.EqualFold(filepath.Ext(name), ".png"):
		what, ok = "PNG", bytes.HasPrefix(head, []byte("\x89PNG\r\n\x1a\n"))
	case k == KindImage:
		what, ok = "JPEG", bytes.HasPrefix(head, []byte{0xFF, 0xD8, 0xFF})
	}
	if !ok {
		return fmt.Errorf("%w: %q isn't a valid %s", ErrInvalid, name, what)
	}
	return nil
}

// HasState reports whether a kind of page can have saved entries: HTML pages
// (their form fields) and PDFs (their AcroForm fields). Images can't.
func HasState(k Kind) bool { return k == KindHTML || k == KindPDF }

func kindOrEmpty(name string) Kind {
	k, _ := KindOf(name)
	return k
}
