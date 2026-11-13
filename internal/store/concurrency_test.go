package store

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"
)

// A slow disk holds up saving, not typing: while one page's entries are being
// written, edits and page loads elsewhere go straight through.
func TestSavingDoesNotBlockEdits(t *testing.T) {
	s := newStore(t)
	sess, _ := s.CreateSession("Slow Disk", "")
	for _, n := range []string{"a.html", "b.html"} {
		if _, err := s.SaveFile(sess.ID, Shared, n, strings.NewReader("<p>x")); err != nil {
			t.Fatal(err)
		}
	}

	writing, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	writeStateFile = func(p string, b []byte) error {
		once.Do(func() { close(writing); <-release })
		return writeAtomic(p, b)
	}
	defer func() { writeStateFile = writeAtomic }()

	if err := s.SetValue(sess.ID, Shared, "a.html", "", "#k", json.RawMessage(`1`)); err != nil {
		t.Fatal(err)
	}
	select {
	case <-writing:
	case <-time.After(2 * time.Second):
		t.Fatal("a.html was never saved")
	}

	done := make(chan error, 1)
	go func() {
		if err := s.SetValue(sess.ID, Shared, "b.html", "", "#k", json.RawMessage(`2`)); err != nil {
			done <- err
			return
		}
		_, err := s.GetState(sess.ID, Shared, "a.html", "")
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("an edit waited for another page's save")
	}
	close(release)
	s.Flush()
}

// Sessions created with the same name at the same moment get an id each.
func TestConcurrentCreatesGetTheirOwnIDs(t *testing.T) {
	s := newStore(t)
	const n = 8
	ids := make(chan string, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			m, err := s.CreateSession("Twin", "")
			if err != nil {
				t.Error(err)
				return
			}
			ids <- m.ID
		}()
	}
	wg.Wait()
	close(ids)
	seen := map[string]bool{}
	for id := range ids {
		if seen[id] {
			t.Fatalf("id %q given out twice", id)
		}
		seen[id] = true
	}
	if list, _ := s.ListSessions(); len(list) != n {
		t.Fatalf("%d sessions listed, want %d", len(list), n)
	}
}
