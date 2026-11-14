// Page kinds: what a file is, how big it may be, and whether it keeps entries.
package store

import (
	"bytes"
	"fmt"
	"path/filepath"
	"strings"

	"mothergoose/internal/pages"
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
	case ".md", ".markdown":
		return KindMD, true
	}
	return "", false
}

// MaxSize is the largest file of each kind that can be added.
func MaxSize(k Kind) int64 {
	switch k {
	case KindPDF:
		return 100 << 20 // rulebooks and scanned maps get big
	case KindMD:
		return 8 << 20 // text: anything bigger is a mistake
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
	case ".md", ".markdown":
		return "text/markdown; charset=utf-8"
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
	case k == KindMD:
		what, ok = "Markdown (text) file", !bytes.ContainsRune(head, 0)
	}
	if !ok {
		return fmt.Errorf("%w: %q isn't a valid %s", ErrInvalid, name, what)
	}
	return nil
}

// HasState reports whether a kind of page can have saved entries: HTML pages
// (their form fields), PDFs (their AcroForm fields) and Markdown pages
// (their task-list boxes). Images can't.
func HasState(k Kind) bool { return k == KindHTML || k == KindPDF || k == KindMD }

// IsPage reports whether a kind is served as a web page, with the page
// script added: HTML, and Markdown once it is turned into HTML.
func IsPage(k Kind) bool { return k == KindHTML || k == KindMD }

// CheckPage checks that an HTML or Markdown page is self-contained, and
// refuses one that loads files from beside it, which can never load: a
// MotherGoose page is a single file. What it loads from the internet, and
// fields without a name, are reported for the referee to decide about.
func CheckPage(name string, k Kind, doc []byte) (pages.Report, error) {
	if k == KindMD {
		body, _, err := pages.Markdown(doc)
		if err != nil {
			return pages.Report{}, fmt.Errorf("%w: %q: %v", ErrInvalid, name, err)
		}
		doc = body
	}
	rep := pages.CheckHTML(doc)
	if len(rep.Local) > 0 {
		more := ""
		if len(rep.Local) >= 12 {
			more = " and more"
		}
		return rep, fmt.Errorf("%w: %q loads files that aren't inside it: %s%s. A page must be one file: put them inside it "+
			"(images as data: URLs, CSS in <style>, scripts in <script>). See Help, then \"Making HTML pages\"",
			ErrInvalid, name, strings.Join(rep.Local, ", "), more)
	}
	return rep, nil
}

func kindOrEmpty(name string) Kind {
	k, _ := KindOf(name)
	return k
}
