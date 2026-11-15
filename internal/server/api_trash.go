package server

import (
	"net/http"

	"mothergoose/internal/store"
)

// The trash: deleted pages and campaigns, cleared entries and removed
// players, kept for store.TrashKeep so they can be put back.

func (s *Server) apiListTrash(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListTrash()
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "keepDays": int(store.TrashKeep.Hours() / 24)})
}

// apiRestoreTrash puts an item back. Under syncMu, like every change to
// whether a page, a copy or its entries exist; viewers of entries put back
// reload, and a player put back gets their copies again.
func (s *Server) apiRestoreTrash(w http.ResponseWriter, r *http.Request) {
	s.syncMu.Lock()
	it, err := s.store.RestoreTrash(r.PathValue("item"))
	if err == nil {
		reload := map[string]string{"type": "reload"}
		switch it.Kind {
		case store.TrashEntries:
			if it.Player != "" {
				s.hub.toRoom(playerRoomKey(it.Session, string(it.Scope), it.Name, it.Player), reload, nil)
			} else {
				s.hub.toFile(it.Session, string(it.Scope), it.Name, reload)
			}
		case store.TrashPlayer:
			s.hub.toPlayer(it.Session, it.Player, reload)
		}
	}
	s.syncMu.Unlock()
	if err != nil {
		storeError(w, err)
		return
	}
	if it.Kind == store.TrashPlayer {
		s.sendPresence()
	}
	s.changed()
	writeJSON(w, http.StatusOK, it)
}

func (s *Server) apiEmptyTrash(w http.ResponseWriter, r *http.Request) {
	if err := s.store.EmptyTrash(); err != nil {
		storeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
