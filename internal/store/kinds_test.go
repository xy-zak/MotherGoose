package store

import (
	"bytes"
	"encoding/json"
	"errors"
	"image"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func pngBytes(t *testing.T) []byte {
	var b bytes.Buffer
	if err := png.Encode(&b, image.NewRGBA(image.Rect(0, 0, 4, 4))); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func jpegBytes(t *testing.T) []byte {
	var b bytes.Buffer
	if err := jpeg.Encode(&b, image.NewRGBA(image.Rect(0, 0, 4, 4)), nil); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

const tinyPDF = "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"

func TestKindOf(t *testing.T) {
	cases := map[string]Kind{"a.html": KindHTML, "A.HTM": KindHTML, "map.pdf": KindPDF, "x.PNG": KindImage, "y.jpg": KindImage, "z.jpeg": KindImage}
	for name, want := range cases {
		if got, ok := KindOf(name); !ok || got != want {
			t.Errorf("KindOf(%q) = %q, %v", name, got, ok)
		}
	}
	for _, name := range []string{"a.svg", "b.gif", "c.txt", "d", "e.pdf.exe"} {
		if _, ok := KindOf(name); ok {
			t.Errorf("KindOf(%q) accepted", name)
		}
	}
}

func TestSaveChecksContent(t *testing.T) {
	s := newStore(t)
	sess, _ := s.CreateSession("Test", "")
	good := map[string][]byte{
		"map.png":        pngBytes(t),
		"photo.jpg":      jpegBytes(t),
		"photo.jpeg":     jpegBytes(t),
		"rules.pdf":      []byte(tinyPDF),
		"junk-first.pdf": append(bytes.Repeat([]byte(" "), 500), tinyPDF...),
	}
	for name, b := range good {
		if _, err := s.SaveFile(sess.ID, Shared, name, bytes.NewReader(b)); err != nil {
			t.Errorf("SaveFile(%s): %v", name, err)
		}
	}
	bad := map[string][]byte{
		"evil.png":  []byte("<script>alert(1)</script>"), // HTML pretending to be an image
		"evil.jpg":  pngBytes(t),                         // wrong image type
		"notes.pdf": []byte("just some text"),
		"empty.png": nil,
	}
	for name, b := range bad {
		if _, err := s.SaveFile(sess.ID, Shared, name, bytes.NewReader(b)); !errors.Is(err, ErrInvalid) {
			t.Errorf("SaveFile(%s) err = %v, want ErrInvalid", name, err)
		}
		if s.Exists(sess.ID, Shared, name) {
			t.Errorf("%s was stored", name)
		}
	}

	files, _ := s.ListFiles(sess.ID, Shared)
	kinds := map[string]Kind{}
	for _, f := range files {
		kinds[f.Name] = f.Kind
		if f.HasState {
			t.Errorf("%s has state", f.Name)
		}
	}
	if kinds["map.png"] != KindImage || kinds["rules.pdf"] != KindPDF || len(files) != len(good) {
		t.Fatalf("files = %+v", files)
	}
	for _, f := range files {
		if f.Name == "rules.pdf" && f.Title != "rules" {
			t.Errorf("pdf title = %q", f.Title)
		}
	}
}

func TestSizeLimitsPerKind(t *testing.T) {
	s := newStore(t)
	sess, _ := s.CreateSession("Test", "")
	// An image just over its limit is refused, and leaves nothing behind.
	big := append(pngBytes(t), make([]byte, MaxSize(KindImage))...)
	if _, err := s.SaveFile(sess.ID, Shared, "huge.png", bytes.NewReader(big)); !errors.Is(err, ErrInvalid) {
		t.Fatalf("oversized png: %v", err)
	}
	// The same size is fine for a PDF.
	pdf := append([]byte(tinyPDF), make([]byte, MaxSize(KindImage))...)
	if _, err := s.SaveFile(sess.ID, Shared, "huge.pdf", bytes.NewReader(pdf)); err != nil {
		t.Fatalf("large pdf: %v", err)
	}
	// Exactly at the limit is allowed.
	exact := append(pngBytes(t), make([]byte, 0)...)
	exact = append(exact, make([]byte, int(MaxSize(KindImage))-len(exact))...)
	if _, err := s.SaveFile(sess.ID, Shared, "exact.png", bytes.NewReader(exact)); err != nil {
		t.Fatalf("png at the limit: %v", err)
	}
	if s.Exists(sess.ID, Shared, "huge.png") {
		t.Fatal("oversized file stored")
	}
	left, _ := filepath.Glob(filepath.Join(s.Root(), "sessions", sess.ID, "shared", ".tmp-*"))
	if len(left) != 0 {
		t.Fatalf("temp files left: %v", left)
	}
}

// PDFs keep their form fields' entries like HTML pages do.
func TestPDFsHaveState(t *testing.T) {
	s := newStore(t)
	sess, _ := s.CreateSession("Test", "")
	s.SaveFile(sess.ID, Shared, "sheet.pdf", strings.NewReader(tinyPDF))
	if err := s.SetValue(sess.ID, Shared, "sheet.pdf", "", "pdf:name", json.RawMessage(`"Aria"`)); err != nil {
		t.Fatal(err)
	}
	s.Flush()
	st, err := s.GetState(sess.ID, Shared, "sheet.pdf", "")
	if err != nil || string(st["pdf:name"]) != `"Aria"` {
		t.Fatalf("state = %v, %v", st, err)
	}
	if f := findFile(mustFiles(t, s, sess.ID, Shared), "sheet.pdf"); f == nil || !f.HasState {
		t.Fatalf("listed = %+v", f)
	}
	if err := s.ResetState(sess.ID, Shared, "sheet.pdf", ""); err != nil {
		t.Fatal(err)
	}
	if st, _ := s.GetState(sess.ID, Shared, "sheet.pdf", ""); len(st) != 0 {
		t.Fatalf("after reset = %v", st)
	}
}

func TestImagesHaveNoState(t *testing.T) {
	s := newStore(t)
	sess, _ := s.CreateSession("Test", "")
	s.SaveFile(sess.ID, Shared, "map.png", bytes.NewReader(pngBytes(t)))
	if _, err := s.GetState(sess.ID, Shared, "map.png", ""); !errors.Is(err, ErrInvalid) {
		t.Errorf("GetState: %v", err)
	}
	if err := s.SetValue(sess.ID, Shared, "map.png", "", "k", json.RawMessage(`1`)); !errors.Is(err, ErrInvalid) {
		t.Errorf("SetValue: %v", err)
	}
	if err := s.ResetState(sess.ID, Shared, "map.png", ""); !errors.Is(err, ErrInvalid) {
		t.Errorf("ResetState: %v", err)
	}
	// Moving and deleting still work.
	if err := s.MoveFile(sess.ID, Shared, "map.png", GM, ""); err != nil {
		t.Fatal(err)
	}
	if err := s.MoveFile(sess.ID, GM, "map.png", GM, "map.html"); !errors.Is(err, ErrInvalid) {
		t.Errorf("renaming png to html: %v", err)
	}
	if err := s.MoveFile(sess.ID, GM, "map.png", GM, "world.jpg"); err != nil {
		t.Errorf("renaming between image types: %v", err)
	}
	if err := s.DeleteFile(sess.ID, GM, "world.jpg"); err != nil {
		t.Fatal(err)
	}
}

func TestOpenFileAndFingerprint(t *testing.T) {
	s := newStore(t)
	sess, _ := s.CreateSession("Test", "")
	before := s.Fingerprint()
	os.WriteFile(filepath.Join(s.Root(), "sessions", sess.ID, "shared", "dropped.pdf"), []byte(tinyPDF), 0o644)
	if s.Fingerprint() == before {
		t.Fatal("hand-dropped PDF not noticed")
	}
	f, fi, err := s.OpenFile(sess.ID, Shared, "dropped.pdf")
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
	if fi.Size() != int64(len(tinyPDF)) {
		t.Fatalf("size = %d", fi.Size())
	}
	if _, _, err := s.OpenFile(sess.ID, Shared, "missing.pdf"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	if !strings.HasPrefix(ContentType("a.JPG"), "image/jpeg") || ContentType("a.pdf") != "application/pdf" {
		t.Fatal("content types")
	}
}
