package server

import (
	"sync"
	"time"
)

// Timings of the "changed" event on /ws/events. Every event makes every open
// dashboard refetch its whole listing, so they are gathered up, not sent one
// per change.
const (
	// changeDelay gathers a burst of changes (a multi-file upload, pages
	// dragged into a new order) into one event.
	changeDelay = 150 * time.Millisecond
	// entriesEvery spaces out the events caused by players typing: their
	// entries are saved about every half second while they type, and the
	// dashboards only show who has filled what in, and when.
	entriesEvery = 5 * time.Second
)

// notifier sends one event, through send, for any number of requests made
// before it goes out.
type notifier struct {
	send func()

	mu   sync.Mutex
	gen  uint64    // the pending timer's number; a timer that isn't the latest does nothing
	due  time.Time // when the pending event goes out; zero if none is pending
	last time.Time // when the last event went out
}

// within asks for an event at most d from now. An event already pending
// sooner than that covers this request; one pending later is brought forward.
func (n *notifier) within(d time.Duration) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.withinLocked(d)
}

// entriesSaved asks for an event after a page's entries were saved: soon,
// unless one went out less than entriesEvery ago.
func (n *notifier) entriesSaved() {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.withinLocked(max(changeDelay, time.Until(n.last.Add(entriesEvery))))
}

func (n *notifier) withinLocked(d time.Duration) {
	at := time.Now().Add(d)
	if !n.due.IsZero() && !n.due.After(at) {
		return
	}
	n.gen++
	g := n.gen
	n.due = at
	time.AfterFunc(d, func() { n.fire(g) })
}

func (n *notifier) fire(g uint64) {
	n.mu.Lock()
	if g != n.gen {
		n.mu.Unlock()
		return // brought forward: an earlier timer already sent it
	}
	n.due = time.Time{}
	n.last = time.Now()
	n.mu.Unlock()
	n.send()
}
