package store

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func newStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestSessionLifecycle(t *testing.T) {
	s := newStore(t)
	a, err := s.CreateSession("The Sunken Keep", "")
	if err != nil {
		t.Fatal(err)
	}
	if a.ID != "the-sunken-keep" {
		t.Fatalf("id = %q", a.ID)
	}
	b, _ := s.CreateSession("The Sunken Keep", "")
	if b.ID != "the-sunken-keep-2" {
		t.Fatalf("duplicate id = %q", b.ID)
	}
	for _, sub := range []string{"shared", "gm", "state", "session.json"} {
		if _, err := os.Stat(filepath.Join(s.Root(), "sessions", a.ID, sub)); err != nil {
			t.Errorf("missing %s: %v", sub, err)
		}
	}
	if _, err := s.RenameSession(a.ID, "Keep, Renamed"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetActive(a.ID); err != nil {
		t.Fatal(err)
	}
	// Active survives reopening.
	s2, _ := Open(s.Root())
	if s2.Active() != a.ID {
		t.Fatalf("active after reopen = %q", s2.Active())
	}
	list, _ := s2.ListSessions()
	if len(list) != 2 {
		t.Fatalf("list = %d", len(list))
	}
	got, _ := s2.GetSession(a.ID)
	if got.Name != "Keep, Renamed" || !got.Active {
		t.Fatalf("got %+v", got.Session)
	}
	if err := s2.DeleteSession(a.ID); err != nil {
		t.Fatal(err)
	}
	if s2.Active() != "" {
		t.Fatal("deleted session still active")
	}
	if _, err := s2.GetSession(a.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
}

func TestDroppedFolderBecomesSession(t *testing.T) {
	s := newStore(t)
	dir := filepath.Join(s.Root(), "sessions", "My Campaign", "shared")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "intro.html"), []byte("<title>Welcome, adventurers</title>"), 0o644)
	os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("ignored"), 0o644)
	list, err := s.ListSessions()
	if err != nil || len(list) != 1 {
		t.Fatalf("list = %v, %v", list, err)
	}
	got := list[0]
	if got.ID != "My Campaign" || got.Name != "My Campaign" {
		t.Fatalf("got %+v", got.Session)
	}
	if len(got.Files[Shared]) != 1 || got.Files[Shared][0].Title != "Welcome, adventurers" {
		t.Fatalf("files = %+v", got.Files)
	}
	if _, err := os.Stat(filepath.Join(s.Root(), "sessions", "My Campaign", "session.json")); err != nil {
		t.Fatal("session.json not created")
	}
}

func TestFilesAndState(t *testing.T) {
	s := newStore(t)
	sess, _ := s.CreateSession("Test", "")
	name, err := s.SaveFile(sess.ID, Shared, `C:\Users\gm\Desktop\aria sheet.HTML`, strings.NewReader("<p>hi</p>"))
	if err != nil {
		t.Fatal(err)
	}
	if name != "aria sheet.HTML" {
		t.Fatalf("name = %q", name)
	}
	if err := s.SetValue(sess.ID, Shared, name, "", "#hp", json.RawMessage(`"12"`)); err != nil {
		t.Fatal(err)
	}
	if err := s.SetValue(sess.ID, Shared, name, "", "#inspired", json.RawMessage(`true`)); err != nil {
		t.Fatal(err)
	}
	s.Flush()

	// State is on disk and survives a restart.
	s2, _ := Open(s.Root())
	st, err := s2.GetState(sess.ID, Shared, name, "")
	if err != nil || string(st["#hp"]) != `"12"` || string(st["#inspired"]) != "true" {
		t.Fatalf("state = %v, %v", st, err)
	}
	// null deletes a key.
	s2.SetValue(sess.ID, Shared, name, "", "#inspired", json.RawMessage(`null`))
	st, _ = s2.GetState(sess.ID, Shared, name, "")
	if _, ok := st["#inspired"]; ok {
		t.Fatal("null did not delete")
	}

	// Moving carries state along; the same name cannot exist in both scopes.
	if err := s2.MoveFile(sess.ID, Shared, name, GM, ""); err != nil {
		t.Fatal(err)
	}
	st, _ = s2.GetState(sess.ID, GM, name, "")
	if string(st["#hp"]) != `"12"` {
		t.Fatalf("state after move = %v", st)
	}
	if _, err := s2.SaveFile(sess.ID, Shared, name, strings.NewReader("x")); !errors.Is(err, ErrExists) {
		t.Fatalf("expected conflict, got %v", err)
	}

	// Re-uploading keeps state; reset and delete clear it.
	if _, err := s2.SaveFile(sess.ID, GM, name, strings.NewReader("<p>v2</p>")); err != nil {
		t.Fatal(err)
	}
	st, _ = s2.GetState(sess.ID, GM, name, "")
	if len(st) != 1 {
		t.Fatalf("state after re-upload = %v", st)
	}
	files, _ := s2.ListFiles(sess.ID, GM)
	if len(files) != 1 || !files[0].HasState {
		t.Fatalf("files = %+v", files)
	}
	s2.ResetState(sess.ID, GM, name, "")
	st, _ = s2.GetState(sess.ID, GM, name, "")
	if len(st) != 0 {
		t.Fatal("reset did not clear")
	}
	if err := s2.DeleteFile(sess.ID, GM, name); err != nil {
		t.Fatal(err)
	}
	if s2.Exists(sess.ID, GM, name) {
		t.Fatal("file still exists")
	}
}

func TestRejectsBadNames(t *testing.T) {
	s := newStore(t)
	sess, _ := s.CreateSession("Test", "")
	for _, n := range []string{"notes.txt", "", ".html", "evil.js", "x.exe"} {
		if _, err := s.SaveFile(sess.ID, Shared, n, strings.NewReader("x")); err == nil {
			t.Errorf("SaveFile(%q) accepted", n)
		}
	}
	// Upload names lose any directory part instead of escaping.
	n, err := s.SaveFile(sess.ID, Shared, "../../../etc/passwd.html", strings.NewReader("x"))
	if err != nil || n != "passwd.html" {
		t.Fatalf("got %q, %v", n, err)
	}
	if !s.Exists(sess.ID, Shared, "passwd.html") {
		t.Fatal("not stored inside the session")
	}
	for _, bad := range []string{"../x.html", "a/b.html", `a\b.html`, ".."} {
		if _, err := s.ReadFile(sess.ID, Shared, bad); !errors.Is(err, ErrInvalid) {
			t.Errorf("ReadFile(%q) err = %v", bad, err)
		}
	}
	for _, bad := range []string{"..", "../x", "a/b", ""} {
		if _, err := s.GetSession(bad); err == nil {
			t.Errorf("GetSession(%q) accepted", bad)
		}
	}
	if _, err := s.ReadFile(sess.ID, Scope("secret"), "a.html"); !errors.Is(err, ErrInvalid) {
		t.Errorf("bad scope err = %v", err)
	}
	if err := s.SetValue(sess.ID, Shared, "passwd.html", "", "k", json.RawMessage(`{not json`)); err == nil {
		t.Error("invalid JSON accepted")
	}
}

func TestFingerprintNoticesDroppedFiles(t *testing.T) {
	s := newStore(t)
	sess, _ := s.CreateSession("Test", "")
	before := s.Fingerprint()
	os.WriteFile(filepath.Join(s.Root(), "sessions", sess.ID, "gm", "secret.html"), []byte("x"), 0o644)
	if s.Fingerprint() == before {
		t.Fatal("fingerprint unchanged")
	}
}

// backups lists the files that quarantine set aside next to p.
func backups(t *testing.T, p string) []string {
	t.Helper()
	m, err := filepath.Glob(p + ".corrupt-*")
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestCorruptStateIsKeptNotOverwritten(t *testing.T) {
	s := newStore(t)
	sess, _ := s.CreateSession("Test", "")
	if _, err := s.SaveFile(sess.ID, Shared, "sheet.html", strings.NewReader("<p>")); err != nil {
		t.Fatal(err)
	}
	p := s.statePath(sess.ID, Shared, "sheet.html", "")
	os.MkdirAll(filepath.Dir(p), 0o755)
	broken := []byte(`{"#hp": "12", "#name": "Ar`) // cut off mid-write, or a bad hand edit
	os.WriteFile(p, broken, 0o644)

	st, err := s.GetState(sess.ID, Shared, "sheet.html", "")
	if err != nil || len(st) != 0 {
		t.Fatalf("GetState = %v, %v; want empty, nil", st, err)
	}
	bak := backups(t, p)
	if len(bak) != 1 {
		t.Fatalf("backups = %v", bak)
	}
	// New edits are saved to a fresh file; the old contents stay in the backup.
	if err := s.SetValue(sess.ID, Shared, "sheet.html", "", "#hp", json.RawMessage(`"9"`)); err != nil {
		t.Fatal(err)
	}
	s.Flush()
	if got, _ := os.ReadFile(bak[0]); string(got) != string(broken) {
		t.Fatalf("backup = %q", got)
	}
	if got, _ := os.ReadFile(p); !strings.Contains(string(got), `"9"`) {
		t.Fatalf("new state = %q", got)
	}
}

func TestUnreadableStateIsAnError(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("needs Unix permissions and a non-root user")
	}
	s := newStore(t)
	sess, _ := s.CreateSession("Test", "")
	s.SaveFile(sess.ID, Shared, "sheet.html", strings.NewReader("<p>"))
	p := s.statePath(sess.ID, Shared, "sheet.html", "")
	os.MkdirAll(filepath.Dir(p), 0o755)
	os.WriteFile(p, []byte(`{"#hp":"12"}`), 0o000)
	defer os.Chmod(p, 0o644)

	if _, err := s.GetState(sess.ID, Shared, "sheet.html", ""); err == nil {
		t.Fatal("GetState succeeded on an unreadable file")
	}
	if err := s.SetValue(sess.ID, Shared, "sheet.html", "", "#hp", json.RawMessage(`"1"`)); err == nil {
		t.Fatal("SetValue succeeded on an unreadable file")
	}
	s.Flush()
	os.Chmod(p, 0o644)
	if got, _ := os.ReadFile(p); string(got) != `{"#hp":"12"}` {
		t.Fatalf("unreadable state was overwritten: %q", got)
	}
}

func TestCorruptSessionMetaIsKept(t *testing.T) {
	s := newStore(t)
	sess, _ := s.CreateSession("The Sunken Keep", "")
	p := filepath.Join(s.Root(), "sessions", sess.ID, "session.json")
	broken := []byte(`{"name": "The Sunken Keep", "created": "2026-01-01T00:00:00Z",}`) // trailing comma
	os.WriteFile(p, broken, 0o644)

	got, err := s.GetSession(sess.ID)
	if err != nil || got.Name != sess.ID {
		t.Fatalf("GetSession = %+v, %v; want default name", got.Session, err)
	}
	bak := backups(t, p)
	if len(bak) != 1 {
		t.Fatalf("backups = %v", bak)
	}
	if b, _ := os.ReadFile(bak[0]); string(b) != string(broken) {
		t.Fatalf("backup = %q", b)
	}
	// Listing again doesn't make more backups: the fresh file is valid.
	s.ListSessions()
	if n := len(backups(t, p)); n != 1 {
		t.Fatalf("%d backups after second read", n)
	}
}

func TestCorruptConfigDoesNotStopStartup(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "config.json")
	os.WriteFile(p, []byte(`{"activeSession": `), 0o644)
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if s.Active() != "" {
		t.Fatalf("active = %q", s.Active())
	}
	if len(backups(t, p)) != 1 {
		t.Fatal("config.json was not kept")
	}
	if b, _ := os.ReadFile(p); !json.Valid(b) {
		t.Fatalf("new config.json = %q", b)
	}
}

func TestWrittenFilesAreReadable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix permissions")
	}
	s := newStore(t)
	sess, _ := s.CreateSession("Test", "")
	s.SaveFile(sess.ID, Shared, "sheet.html", strings.NewReader("<p>"))
	s.SetValue(sess.ID, Shared, "sheet.html", "", "#hp", json.RawMessage(`"1"`))
	s.Flush()
	for _, p := range []string{
		filepath.Join(s.Root(), "config.json"),
		filepath.Join(s.Root(), "sessions", sess.ID, "session.json"),
		filepath.Join(s.Root(), "sessions", sess.ID, "shared", "sheet.html"),
		s.statePath(sess.ID, Shared, "sheet.html", ""),
	} {
		fi, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm() != fileMode {
			t.Errorf("%s: mode %o, want %o", filepath.Base(p), fi.Mode().Perm(), fileMode)
		}
	}
	// No temp files are left behind.
	left, _ := filepath.Glob(filepath.Join(s.Root(), "sessions", sess.ID, "*", ".tmp-*"))
	if len(left) != 0 {
		t.Fatalf("temp files left: %v", left)
	}
}
